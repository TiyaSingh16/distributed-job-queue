const express = require('express');
require('dotenv').config();
const mongoose = require('mongoose');
const { Worker, UnrecoverableError } = require('bullmq');
const sharp = require('sharp');
const cloudinary = require('cloudinary').v2;
const Job = require('./models');
const { resizePayload } = require('./validation');
const { fetchImage, isRejectedUrl } = require('./safe-fetch');
const { redisConnection, workerConcurrency } = require('./config');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// sharp refuses to decode images with more pixels than this. A small,
// highly compressed file can decode to gigabytes (a "decompression bomb");
// 40 megapixels is about 160MB of raw RGBA. sharp's default is ~268MP.
const MAX_INPUT_PIXELS = 40_000_000;

// HTTP statuses that mean "try again later"; every other 4xx is permanent.
const RETRYABLE_4XX = [408, 429];

function isPermanentHttpError(status) {
  return status >= 400 && status < 500 && !RETRYABLE_4XX.includes(status);
}

// Throws UnrecoverableError for failures no retry can fix, so BullMQ fails the
// job immediately. Any other error is retried per the queue's job options.
async function processJob(job) {
  console.log(`Processing job ${job.id}:`, job.data);
  // Same rules as the API. Also catches records created before validation.
  const parsed = resizePayload.safeParse(job.data);
  if (!parsed.success) {
    throw new UnrecoverableError(`Invalid job data: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const { imageUrl, width, height } = parsed.data;

  await Job.findOneAndUpdate({ bullJobId: job.id }, { status: 'processing' });

  // 1. Download the source image (SSRF-guarded, max 15MB; see safe-fetch.js)
  let response;
  try {
    response = await fetchImage(imageUrl);
  } catch (err) {
    if (isRejectedUrl(err)) {
      throw new UnrecoverableError(`Refusing to download the image: ${err.cause?.message || err.message}`);
    }
    if (/maxContentLength/.test(err.message)) {
      throw new UnrecoverableError('The image is larger than the 15MB download limit.');
    }
    const status = err.response?.status;
    const message = `Could not download the image (${status || err.code || 'network error'}). Check that the URL is publicly accessible.`;
    throw isPermanentHttpError(status) ? new UnrecoverableError(message) : new Error(message);
  }

  // 2. Confirm we actually got an image back, not an HTML error/redirect page
  const contentType = response.headers['content-type'] || '';
  if (!contentType.startsWith('image/')) {
    throw new UnrecoverableError(
      'The URL did not return an image. Make sure it links directly to an image file, not a webpage (e.g. not a Google Images or Instagram link).'
    );
  }

  const inputBuffer = Buffer.from(response.data);

  // 3. Resize it with sharp (in-memory, no disk write)
  let resizedBuffer;
  try {
    resizedBuffer = await sharp(inputBuffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize(width, height, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (err) {
    throw new UnrecoverableError(`Could not process the image — it may be corrupted or an unsupported format (${err.message}).`);
  }

  // 4. Upload the resized buffer to Cloudinary. A fixed public_id means a
  // retry overwrites the same asset instead of creating a second one.
  const uploadResult = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'job-queue-resized', public_id: `resized-${job.id}` },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(resizedBuffer);
  });

  const result = {
    imageUrl: uploadResult.secure_url,
    sizeKB: Math.round(uploadResult.bytes / 1024),
  };
  await Job.findOneAndUpdate({ bullJobId: job.id }, { status: 'completed', result });

  console.log(`Job ${job.id} completed — ${uploadResult.secure_url}`);
  // Returned so BullMQ stores it; the sweeper copies it into Mongo if the
  // write above is ever lost.
  return result;
}

// True when BullMQ will not run the job again. BullMQ increments attemptsMade
// before emitting 'failed', so after the last attempt attemptsMade === attempts.
function isFinalAttempt(job, err) {
  if (err instanceof UnrecoverableError || err?.name === 'UnrecoverableError') return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

// 'failed' fires after every failed attempt, including ones BullMQ will retry.
// Only the final one is the job's true final state.
async function handleFailed(job, err) {
  // BullMQ can emit 'failed' without a job (e.g. stalled-job errors).
  if (!job) return;
  const final = isFinalAttempt(job, err);
  console.log(`❌ Job ${job.id} failed (attempt ${job.attemptsMade}${final ? ', final' : ', will retry'}):`, err.message);
  if (!final) return;
  await Job.findOneAndUpdate({ bullJobId: job.id }, { status: 'failed', error: err.message });
}

// On SIGTERM (sent by the host on deploy/scale-down) or SIGINT (Ctrl+C), stop
// taking new jobs and let active ones finish before exiting. worker.close()
// resolves once active jobs are done. A job cut off anyway (the host
// SIGKILLs after its grace period) is detected as stalled by BullMQ and
// re-run, which is safe because processing is idempotent.
function registerShutdown(worker, { proc = process, exit = process.exit } = {}) {
  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, waiting for active jobs to finish...`);
    try {
      await worker.close();
      exit(0);
    } catch (err) {
      console.error('Error while closing worker:', err);
      exit(1);
    }
  }
  proc.on('SIGTERM', () => shutdown('SIGTERM'));
  proc.on('SIGINT', () => shutdown('SIGINT'));
}

// Only connect and start consuming when run directly (`node worker.js`), so
// tests can require this file without touching Redis, Mongo or a port.
if (require.main === module) {
  const app = express();
  app.get('/', (req, res) => res.send('Worker is running'));
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Dummy listener running on port ${PORT} (worker is alive)`));

  mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB connected (worker)'))
    .catch((err) => console.error('MongoDB connection error:', err));

  const worker = new Worker('jobs', processJob, {
    connection: redisConnection(),
    concurrency: workerConcurrency(),
  });
  registerShutdown(worker);

  worker.on('completed', (job) => {
    console.log(`✅ Job ${job.id} has completed`);
  });

  // If this write is lost, the sweeper later copies BullMQ's failed state.
  worker.on('failed', (job, err) => {
    handleFailed(job, err).catch((e) => console.error(`Could not record failure of job ${job?.id}:`, e));
  });
}

module.exports = { processJob, handleFailed, isFinalAttempt, registerShutdown, MAX_INPUT_PIXELS };

const express = require('express');
require('dotenv').config();
const mongoose = require('mongoose');
const { Worker, UnrecoverableError } = require('bullmq');
const axios = require('axios');
const sharp = require('sharp');
const cloudinary = require('cloudinary').v2;
const Job = require('./models');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const connection = {
  host: 'ideal-hyena-181940.upstash.io',
  port: 6379,
  password: process.env.REDIS_PASSWORD,
  tls: {},
};

// HTTP statuses that mean "try again later"; every other 4xx is permanent.
const RETRYABLE_4XX = [408, 429];

function isPermanentHttpError(status) {
  return status >= 400 && status < 500 && !RETRYABLE_4XX.includes(status);
}

// Throws UnrecoverableError for failures no retry can fix, so BullMQ fails the
// job immediately. Any other error is retried per the queue's job options.
async function processJob(job) {
  console.log(`Processing job ${job.id}:`, job.data);
  const { imageUrl, width, height } = job.data;
  if (typeof imageUrl !== 'string' || !imageUrl) {
    throw new UnrecoverableError('Job is missing an imageUrl.');
  }

  await Job.findOneAndUpdate({ bullJobId: job.id }, { status: 'processing' });

  // 1. Download the source image, pretending to be a real browser
  let response;
  try {
    response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
      timeout: 10000,
    });
  } catch (err) {
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
    resizedBuffer = await sharp(inputBuffer)
      .resize(width || 300, height || 300, { fit: 'inside', withoutEnlargement: true })
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

  const worker = new Worker('jobs', processJob, { connection });

  worker.on('completed', (job) => {
    console.log(`✅ Job ${job.id} has completed`);
  });

  // If this write is lost, the sweeper later copies BullMQ's failed state.
  worker.on('failed', (job, err) => {
    handleFailed(job, err).catch((e) => console.error(`Could not record failure of job ${job?.id}:`, e));
  });
}

module.exports = { processJob, handleFailed, isFinalAttempt };

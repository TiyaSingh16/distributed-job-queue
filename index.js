const cors = require('cors');
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Queue } = require('bullmq');
const Job = require('./models');
const { startSweeper } = require('./sweeper');
const { createJobBody, uploadFields, formatIssues } = require('./validation');
const { redisConnection } = require('./config');

const app = express();
app.use(cors());
app.use(express.json());

// Multer stores the uploaded file in memory (as a buffer) — we never
// write it to disk, since we immediately forward it to Cloudinary.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB cap

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Every job (including ones the sweeper re-adds) gets up to 3 attempts,
// retried after 2s, then 4s. The worker skips retries for permanent errors.
const jobQueue = new Queue('jobs', {
  connection: redisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  },
});

// Duplicate job ids are prevented by the database, not by application code:
// models.js declares a unique index on bullJobId, so if two inserts ever
// carried the same id, MongoDB would accept one and reject the other with
// error code 11000 (duplicate key), atomically, even under concurrency. A
// "check whether the id exists, then insert" in application code could not
// guarantee that, because two requests can both pass the check.
//
// The id is a fresh ObjectId generated here, never taken from the client, so a
// collision is practically impossible (timestamp + per-process random value +
// counter). If one happens anyway, retry once with a new id rather than fail
// the user's request; a second collision indicates a real bug, so surface it.
const DUPLICATE_KEY = 11000;
const MAX_ID_ATTEMPTS = 2;

async function createJobRecord(type, payload) {
  for (let attempt = 1; ; attempt++) {
    const _id = new mongoose.Types.ObjectId();
    try {
      return await Job.create({
        _id,
        bullJobId: String(_id),
        type: type || 'default-job',
        payload: payload || {},
        status: 'queued',
      });
    } catch (err) {
      if (err?.code === DUPLICATE_KEY && attempt < MAX_ID_ATTEMPTS) {
        console.warn(`Duplicate job id ${_id} on insert; retrying with a new id`);
        continue;
      }
      throw err;
    }
  }
}

// Shared helper: persist a Mongo record, then push the job onto the queue.
// The record is written first so the worker's status updates always find it.
// Its _id doubles as the BullMQ jobId, so re-adding the same job is a no-op.
async function enqueueJob(type, payload) {
  const jobRecord = await createJobRecord(type, payload);
  const jobId = jobRecord.bullJobId;
  try {
    await jobQueue.add(jobRecord.type, jobRecord.payload, { jobId });
  } catch (err) {
    // The record stays 'queued'; the sweeper will re-add it.
    console.error(`Failed to add job ${jobId} to queue:`, err);
  }
  return { jobId, mongoId: jobRecord._id };
}

// EXISTING: submit a job via image URL
app.post('/jobs', async (req, res) => {
  // Validate before anything is written, so a bad request leaves no record.
  const parsed = createJobBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid job', errors: formatIssues(parsed.error) });
  }
  try {
    const { type, payload } = parsed.data;
    const result = await enqueueJob(type, payload);
    res.status(202).json({ message: 'Job submitted', ...result });
  } catch (err) {
    console.error('Error submitting job:', err);
    res.status(500).json({ message: 'Failed to submit job' });
  }
});

// NEW: submit a job by uploading a file directly from the user's device
app.post('/jobs/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Validate the form fields before spending a Cloudinary upload on them.
    const parsed = uploadFields.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid job', errors: formatIssues(parsed.error) });
    }
    const { width, height } = parsed.data;

    // Upload the raw file to Cloudinary first to get a public URL —
    // the queue/worker then downloads THIS url and does the actual resize,
    // so the rest of the pipeline is unchanged.
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'job-queue-originals' },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    const result = await enqueueJob('resize-image', {
      imageUrl: uploadResult.secure_url,
      width,
      height,
    });

    res.status(202).json({ message: 'Job submitted', ...result });
  } catch (err) {
    console.error('Error uploading file:', err);
    res.status(500).json({ message: 'Failed to upload and submit job' });
  }
});

// List job history — supports pagination and filtering by status
// e.g. GET /jobs?page=1&limit=20&status=completed
app.get('/jobs', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100); // cap at 100 per page
    const filter = {};
    if (req.query.status) {
      const validStatuses = ['queued', 'processing', 'completed', 'failed'];
      if (!validStatuses.includes(req.query.status)) {
        return res.status(400).json({ message: `status must be one of: ${validStatuses.join(', ')}` });
      }
      filter.status = req.query.status;
    }

    const [jobs, total] = await Promise.all([
      Job.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Job.countDocuments(filter),
    ]);

    res.json({
      jobs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('Error listing jobs:', err);
    res.status(500).json({ message: 'Failed to list jobs' });
  }
});

// Status check for a single job
app.get('/jobs/:bullJobId', async (req, res) => {
  try {
    const job = await Job.findOne({ bullJobId: req.params.bullJobId });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    res.json(job);
  } catch (err) {
    console.error('Error fetching job:', err);
    res.status(500).json({ message: 'Failed to fetch job status' });
  }
});

// Liveness check for the hosting platform and for verifying a deploy.
// Deliberately does not touch Mongo or Redis: it answers "is this process up
// and serving HTTP", not "are all dependencies healthy".
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Anything that reaches here matched no route.
app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

// Last-resort error handler. Without it, Express's default handler answers
// with an HTML page that includes the stack trace whenever NODE_ENV is not
// 'production'. Every error response from this API is JSON with a `message`
// written for the user; details only go to the server log.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Request body must be valid JSON.' });
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'The image is larger than the 10 MB upload limit.' });
    }
    return res.status(400).json({ message: 'The upload could not be read. Send one image in the "image" field.' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Something went wrong on the server. Please try again.' });
});

// Only start listening when run directly (`node index.js`), so tests can
// require this file without binding a port.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
  startSweeper(Job, jobQueue);

  // Mongoose builds the indexes declared in models.js in the background and
  // does NOT crash if that fails. Building the unique bullJobId index fails
  // if existing records already share an id (possible for records created
  // before ids were ObjectIds), and the app would then run without the
  // guarantee while looking healthy. Make that failure loud.
  Job.init().then(
    () => console.log('Job indexes are in place'),
    (err) =>
      console.error(
        'Could not build Job indexes. If this is a duplicate key error, run ' +
          '`node scripts/check-job-ids.js` to list the duplicate bullJobIds:',
        err
      )
  );
}

module.exports = { app, enqueueJob };
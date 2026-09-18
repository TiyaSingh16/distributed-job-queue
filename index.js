const cors = require('cors');
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Queue } = require('bullmq');
const Job = require('./models');

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

const connection = {
  host: 'ideal-hyena-181940.upstash.io',
  port: 6379,
  password: process.env.REDIS_PASSWORD,
  tls: {},
};

const jobQueue = new Queue('jobs', { connection });

// Shared helper: push a job onto the queue + persist a Mongo record
async function enqueueJob(type, payload) {
  const bullJob = await jobQueue.add(type || 'default-job', payload || {});
  const jobRecord = await Job.create({
    bullJobId: bullJob.id,
    type: type || 'default-job',
    payload: payload || {},
    status: 'queued',
  });
  return { jobId: bullJob.id, mongoId: jobRecord._id };
}

// EXISTING: submit a job via image URL
app.post('/jobs', async (req, res) => {
  try {
    const { type, payload } = req.body;
    const result = await enqueueJob(type, payload);
    res.status(201).json({ message: 'Job submitted', ...result });
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

    const { width, height } = req.body;

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
      width: Number(width) || 300,
      height: Number(height) || 300,
    });

    res.status(201).json({ message: 'Job submitted', ...result });
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
  const job = await Job.findOne({ bullJobId: req.params.bullJobId });
  if (!job) return res.status(404).json({ message: 'Job not found' });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
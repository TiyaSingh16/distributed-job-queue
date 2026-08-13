const cors = require('cors');
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { Queue } = require('bullmq');
const Job = require('./models');

const app = express();
app.use(cors());
app.use(express.json());

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

app.post('/jobs', async (req, res) => {
  const { type, payload } = req.body;

  // Push to BullMQ/Redis
  const bullJob = await jobQueue.add(type || 'default-job', payload || {});

  // Persist a record in MongoDB
  const jobRecord = await Job.create({
    bullJobId: bullJob.id,
    type: type || 'default-job',
    payload: payload || {},
    status: 'queued',
  });

  res.status(201).json({
    message: 'Job submitted',
    jobId: bullJob.id,
    mongoId: jobRecord._id,
  });
});

// NEW: status check endpoint
app.get('/jobs/:bullJobId', async (req, res) => {
  const job = await Job.findOne({ bullJobId: req.params.bullJobId });
  if (!job) return res.status(404).json({ message: 'Job not found' });
  res.json(job);
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
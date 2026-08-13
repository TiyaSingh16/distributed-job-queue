require('dotenv').config();
const mongoose = require('mongoose');
const { Worker } = require('bullmq');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const Job = require('./models');

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected (worker)'))
  .catch((err) => console.error('MongoDB connection error:', err));

const connection = {
  host: 'ideal-hyena-181940.upstash.io',
  port: 6379,
  password: process.env.REDIS_PASSWORD,
  tls: {},
};

const worker = new Worker(
  'jobs',
  async (job) => {
    console.log(`Processing job ${job.id}:`, job.data);
    await Job.findOneAndUpdate({ bullJobId: job.id }, { status: 'processing' });

    const { imageUrl, width, height } = job.data;

    // 1. Download the source image
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const inputBuffer = Buffer.from(response.data);

    // 2. Resize it with sharp
    const outputFilename = `resized-${job.id}.jpg`;
    const outputPath = path.join(__dirname, 'outputs', outputFilename);

    await sharp(inputBuffer)
      .resize(width || 300, height || 300)
      .jpeg({ quality: 80 })
      .toFile(outputPath);

    // 3. Check the resulting file size
    const stats = fs.statSync(outputPath);

    await Job.findOneAndUpdate(
      { bullJobId: job.id },
      {
        status: 'completed',
        result: {
          outputPath: `outputs/${outputFilename}`,
          sizeKB: Math.round(stats.size / 1024),
        },
      }
    );

    console.log(`Job ${job.id} completed — saved to ${outputPath}`);
    return { status: 'done' };
  },
  { connection }
);

worker.on('completed', (job) => {
  console.log(`✅ Job ${job.id} has completed`);
});

worker.on('failed', async (job, err) => {
  console.log(`❌ Job ${job.id} failed:`, err.message);
  await Job.findOneAndUpdate({ bullJobId: job.id }, { status: 'failed', error: err.message });
});
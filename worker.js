require('dotenv').config();
const mongoose = require('mongoose');
const { Worker } = require('bullmq');
const axios = require('axios');
const sharp = require('sharp');
const cloudinary = require('cloudinary').v2;
const Job = require('./models');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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

    // 2. Resize it with sharp (still in-memory, no disk write)
    const resizedBuffer = await sharp(inputBuffer)
      .resize(width || 300, height || 300)
      .jpeg({ quality: 80 })
      .toBuffer();

    // 3. Upload the resized buffer to Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'job-queue-resized', public_id: `resized-${job.id}` },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(resizedBuffer);
    });

    await Job.findOneAndUpdate(
      { bullJobId: job.id },
      {
        status: 'completed',
        result: {
          imageUrl: uploadResult.secure_url,
          sizeKB: Math.round(uploadResult.bytes / 1024),
        },
      }
    );

    console.log(`Job ${job.id} completed — ${uploadResult.secure_url}`);
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
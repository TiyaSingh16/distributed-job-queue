const express = require('express');
require('dotenv').config();
const mongoose = require('mongoose');
const { Worker } = require('bullmq');
const axios = require('axios');
const sharp = require('sharp');
const cloudinary = require('cloudinary').v2;
const Job = require('./models');
const app = express();
app.get('/', (req, res) => res.send('Worker is running'));
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Dummy listener running on port ${PORT} (worker is alive)`));
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
      throw new Error(
        `Could not download the image (${err.response?.status || err.code || 'network error'}). Check that the URL is publicly accessible.`
      );
    }

    // 2. Confirm we actually got an image back, not an HTML error/redirect page
    const contentType = response.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) {
      throw new Error(
        'The URL did not return an image. Make sure it links directly to an image file, not a webpage (e.g. not a Google Images or Instagram link).'
      );
    }

    const inputBuffer = Buffer.from(response.data);

    // 3. Resize it with sharp (in-memory, no disk write)
    let resizedBuffer;
    try {
      resizedBuffer = await sharp(inputBuffer)
        .resize(width || 300, height || 300)
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch (err) {
      throw new Error(`Could not process the image — it may be corrupted or an unsupported format (${err.message}).`);
    }

    // 4. Upload the resized buffer to Cloudinary
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
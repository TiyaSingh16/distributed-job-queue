// One worker process for the load test (bench/run.js starts 1, 2 or 4 of them).
//
// What is REAL: Redis, BullMQ (queue, locking, retries), and worker.js's
// processJob(), including payload validation and the sharp resize.
// What is STUBBED, and why:
//   - the image download (safe-fetch.js): the SSRF guard correctly refuses to
//     fetch from localhost, and fetching from the internet would make runs
//     depend on someone else's server. The stub returns a fixture image.
//   - the Cloudinary upload: external and metered.
//   - Mongo status writes: no MongoDB server is available in the test
//     environment. These are small single-document updates.
// BENCH_IO_MS adds an artificial delay to the stubbed download and upload, to
// model network I/O. With BENCH_IO_MS=0 the job is CPU-bound (resize only).
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ioMs = Number(process.env.BENCH_IO_MS || 0);
const fixture = fs.readFileSync(process.env.BENCH_FIXTURE);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stubModule(id, exports) {
  const key = require.resolve(id);
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
}

stubModule(path.join(root, 'safe-fetch.js'), {
  fetchImage: async () => {
    if (ioMs) await sleep(ioMs);
    return { headers: { 'content-type': 'image/jpeg' }, data: fixture };
  },
  isRejectedUrl: () => false,
});
stubModule(path.join(root, 'models.js'), { findOneAndUpdate: async () => null });
stubModule(require.resolve('cloudinary', { paths: [root] }), {
  v2: {
    config: () => {},
    uploader: {
      upload_stream: (opts, cb) => ({
        end: (buffer) => {
          setTimeout(() => cb(null, { secure_url: `bench://${opts.public_id}`, bytes: buffer.length }), ioMs);
        },
      }),
    },
  },
});

const { Worker } = require(require.resolve('bullmq', { paths: [root] }));
const { processJob, handleFailed, registerShutdown } = require(path.join(root, 'worker.js'));
const { redisConnection, workerConcurrency } = require(path.join(root, 'config.js'));

console.log = () => {}; // processJob logs every job; keep the benchmark quiet

const worker = new Worker('jobs', processJob, {
  connection: redisConnection(),
  concurrency: workerConcurrency(),
});
worker.on('failed', (job, err) => handleFailed(job, err).catch(() => {}));
worker.on('error', (err) => console.error('worker error:', err.message));
worker.waitUntilReady().then(() => process.send && process.send({ type: 'ready' }));
registerShutdown(worker);

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

// Integration tests against a REAL Redis and REAL BullMQ. The unit tests fake
// BullMQ, so behaviour this design depends on is only *assumed* there:
//   - add() with an existing jobId is ignored (the outbox/sweeper relies on it)
//   - 'failed' fires per attempt and attemptsMade tells the final one
//   - getJob()/getState()/returnvalue give the reconciler the true outcome
// Here the image download, Cloudinary and Mongo are still stubbed (no external
// services), but queueing, locking, retries and state are BullMQ's own.
//
// Skipped unless INTEGRATION_REDIS_HOST is set, e.g.
//   INTEGRATION_REDIS_HOST=127.0.0.1 npm run test:integration
// The tests use a uniquely named queue and remove it afterwards.
const REDIS_HOST = process.env.INTEGRATION_REDIS_HOST;
const REDIS_PORT = Number(process.env.INTEGRATION_REDIS_PORT || 6379);

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..', '..');

function stubModule(id, exports) {
  const key = require.resolve(id);
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
}

const control = { fetchPlan: [], fetchCalls: 0, mongoWrites: [], uploads: 0 };
let image;

async function nextFetch() {
  control.fetchCalls += 1;
  const step = control.fetchPlan.length ? control.fetchPlan.shift() : 'ok';
  if (step === 'reset') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  if (step === 'html') return { headers: { 'content-type': 'text/html' }, data: Buffer.from('<html></html>') };
  return { headers: { 'content-type': 'image/jpeg' }, data: image };
}

describe.skipIf(!REDIS_HOST)('queue integration (real Redis + BullMQ)', () => {
  let Queue;
  let Worker;
  let worker;
  let queue;
  let processJob;
  let handleFailed;
  let sweepOnce;
  let STALE_AFTER_MS;
  const connection = { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null };
  const queueName = `it-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    const sharp = require('sharp');
    image = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#3366aa' } }).jpeg().toBuffer();

    stubModule(path.join(root, 'safe-fetch.js'), { fetchImage: nextFetch, isRejectedUrl: () => false });
    stubModule(path.join(root, 'models.js'), {
      findOneAndUpdate: async (filter, update) => {
        control.mongoWrites.push({ id: filter.bullJobId, ...update });
        return null;
      },
    });
    stubModule('cloudinary', {
      v2: {
        config: () => {},
        uploader: {
          upload_stream: (opts, cb) => ({
            end: (buf) => {
              control.uploads += 1;
              cb(null, { secure_url: `https://res.cloudinary.test/${opts.public_id}.jpg`, bytes: buf.length });
            },
          }),
        },
      },
    });
    ({ Queue, Worker } = require('bullmq'));
    ({ processJob, handleFailed } = require(path.join(root, 'worker.js')));
    ({ sweepOnce, STALE_AFTER_MS } = require(path.join(root, 'sweeper.js')));

    queue = new Queue(queueName, { connection });
    worker = new Worker(queueName, processJob, { connection, concurrency: 2 });
    worker.on('failed', (job, err) => handleFailed(job, err));
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
  });

  beforeEach(() => {
    control.fetchPlan = [];
    control.fetchCalls = 0;
    control.mongoWrites = [];
    control.uploads = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  const payload = { imageUrl: 'https://images.example/a.jpg', width: 300, height: 300 };
  const fastRetries = { attempts: 3, backoff: { type: 'fixed', delay: 50 } };

  async function settled(jobId, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await queue.getJob(jobId);
      const state = job && (await job.getState());
      if (state === 'completed' || state === 'failed') return { job, state };
      if (Date.now() > deadline) throw new Error(`job ${jobId} still ${state}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('processes a job end to end and stores the result in BullMQ', async () => {
    await queue.add('resize-image', payload, { jobId: 'ok-1', ...fastRetries });
    const { job, state } = await settled('ok-1');

    expect(state).toBe('completed');
    expect(job.returnvalue).toMatchObject({ imageUrl: 'https://res.cloudinary.test/resized-ok-1.jpg' });
    expect(control.mongoWrites.map((w) => w.status)).toEqual(['processing', 'completed']);
  });

  it('ignores a second add() with the same jobId (what the sweeper relies on)', async () => {
    const first = await queue.add('resize-image', payload, { jobId: 'dup-1', ...fastRetries });
    const second = await queue.add('resize-image', payload, { jobId: 'dup-1', ...fastRetries });
    await settled('dup-1');
    // Re-adding after completion is also a no-op while BullMQ keeps the job.
    await queue.add('resize-image', payload, { jobId: 'dup-1', ...fastRetries });
    await new Promise((r) => setTimeout(r, 200));

    expect(second.id).toBe(first.id);
    expect(control.uploads).toBe(1);
  });

  it('retries a transient download error and never writes "failed" for a non-final attempt', async () => {
    control.fetchPlan = ['reset', 'ok'];
    await queue.add('resize-image', payload, { jobId: 'flaky-1', ...fastRetries });
    const { state } = await settled('flaky-1');

    expect(state).toBe('completed');
    expect(control.fetchCalls).toBe(2);
    expect(control.mongoWrites.some((w) => w.status === 'failed')).toBe(false);
    expect(control.mongoWrites.at(-1).status).toBe('completed');
  });

  it('fails a permanent error after one attempt, with a user-facing message', async () => {
    control.fetchPlan = ['html'];
    await queue.add('resize-image', payload, { jobId: 'html-1', ...fastRetries });
    const { state } = await settled('html-1');
    await new Promise((r) => setTimeout(r, 100)); // let the 'failed' handler write

    expect(state).toBe('failed');
    // One download attempt: UnrecoverableError skipped the two retries.
    expect(control.fetchCalls).toBe(1);
    expect(control.mongoWrites.at(-1)).toMatchObject({ status: 'failed', error: expect.stringMatching(/did not return an image/) });
  });

  it('marks failed only after the last of 3 attempts when every attempt fails', async () => {
    control.fetchPlan = ['reset', 'reset', 'reset'];
    await queue.add('resize-image', payload, { jobId: 'down-1', ...fastRetries });
    const { state } = await settled('down-1');
    await new Promise((r) => setTimeout(r, 100));
    const job = await queue.getJob('down-1'); // re-read after BullMQ finished its bookkeeping

    expect(state).toBe('failed');
    expect(control.fetchCalls).toBe(3);
    expect(job.attemptsMade).toBe(3);
    expect(control.mongoWrites.filter((w) => w.status === 'failed')).toHaveLength(1);
  });

  it('reconciler copies the real BullMQ outcome when the worker\'s Mongo write was lost', async () => {
    await queue.add('resize-image', payload, { jobId: 'lost-1', ...fastRetries });
    const { job } = await settled('lost-1');

    // Mongo never heard about completion: the record is still 'processing'.
    const docs = [{ bullJobId: 'lost-1', status: 'processing', createdAt: new Date(Date.now() - STALE_AFTER_MS - 1000) }];
    const Job = {
      find: async (f) => docs.filter((d) => f.status.$in.includes(d.status) && d.createdAt < f.createdAt.$lt),
      findOneAndUpdate: async (f, update) => {
        const d = docs.find((x) => x.bullJobId === f.bullJobId && (!f.status || f.status.$in.includes(x.status)));
        if (d) Object.assign(d, update);
        return d || null;
      },
    };
    await sweepOnce(Job, queue);

    expect(docs[0].status).toBe('completed');
    expect(docs[0].result).toEqual(job.returnvalue);
  });
});

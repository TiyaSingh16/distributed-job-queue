import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

// index.js is CommonJS and loads its dependencies with plain require(), which
// vi.mock does not reliably intercept. Instead we seed Node's require cache
// with fakes before loading index.js, so its require() calls get them.
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');
const { sweepOnce, STALE_AFTER_MS } = require(path.join(root, 'sweeper.js'));

function stubModule(id, exports) {
  const key = require.resolve(id);
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
}

// Stand-in for mongoose: connect() is a no-op and ObjectId yields unique ids.
function createFakeMongoose() {
  let nextId = 1;
  class ObjectId {
    constructor() {
      this.hex = (nextId++).toString(16).padStart(24, '0');
    }
    toString() {
      return this.hex;
    }
  }
  return { connect: () => Promise.resolve(), Types: { ObjectId } };
}

// In-memory stand-in for the Mongoose Job model. findOneAndUpdate mirrors
// Mongoose's default (no upsert): if no document matches, it writes nothing
// and resolves to null. find() supports only the sweeper's query.
function createFakeJobModel() {
  const docs = [];
  return {
    docs,
    createErrors: [],
    async create(fields) {
      if (this.createErrors.length) throw this.createErrors.shift();
      const doc = { createdAt: new Date(), ...fields };
      docs.push(doc);
      return doc;
    },
    async findOneAndUpdate(filter, update) {
      const doc = docs.find((d) => d.bullJobId === filter.bullJobId);
      if (!doc) return null;
      Object.assign(doc, update);
      return doc;
    },
    async find(filter) {
      return docs.filter(
        (d) => filter.status.$in.includes(d.status) && d.createdAt < filter.createdAt.$lt
      );
    },
  };
}

// Fake BullMQ Queue. Mirrors BullMQ's handling of a custom jobId: if a job
// with that id already exists, add() returns it and creates nothing.
// Hooks let a test fail add() or run code after the job "exists in Redis"
// but before add() resolves (e.g. a worker failing it immediately).
function createFakeBullmq(hooks) {
  class Queue {
    constructor(name, opts) {
      this.jobs = new Map();
      this.opts = opts;
      hooks.queue = this;
    }
    async add(name, data, opts = {}) {
      if (hooks.addError) throw hooks.addError;
      const existing = this.jobs.get(opts.jobId);
      if (existing) return existing;
      const job = { id: opts.jobId, name, data };
      this.jobs.set(job.id, job);
      if (hooks.beforeAddResolves) await hooks.beforeAddResolves(job);
      return job;
    }
    // Jobs in this fake never progress past 'waiting'.
    async getJob(id) {
      const job = this.jobs.get(id);
      return job && { ...job, getState: async () => 'waiting' };
    }
  }
  return { Queue };
}

describe('enqueueJob and sweeper', () => {
  let Job;
  let hooks;
  let enqueueJob;

  beforeEach(() => {
    Job = createFakeJobModel();
    hooks = {};
    stubModule('bullmq', createFakeBullmq(hooks));
    stubModule('mongoose', createFakeMongoose());
    stubModule(path.join(root, 'models.js'), Job);

    const indexPath = require.resolve(path.join(root, 'index.js'));
    delete require.cache[indexPath];
    ({ enqueueJob } = require(indexPath));
  });

  // Ages a record past the sweeper's threshold.
  function makeStale(jobId) {
    const record = Job.docs.find((d) => d.bullJobId === jobId);
    record.createdAt = new Date(Date.now() - STALE_AFTER_MS - 1000);
  }

  it('records a job as failed when the worker fails it before add() resolves', async () => {
    let failedUpdateResult;

    // Sequence of events:
    //   1. API: jobQueue.add() puts the job in Redis.
    //   2. Worker: picks up the job, fails fast, and its 'failed' handler runs
    //      the same update as worker.js:108.
    //   3. API: add() resolves.
    // Before the fix, Job.create ran after step 3, so step 2 matched nothing
    // and the record was then written as 'queued' forever.
    hooks.beforeAddResolves = async (job) => {
      failedUpdateResult = await Job.findOneAndUpdate(
        { bullJobId: job.id },
        { status: 'failed', error: 'Could not download the image' }
      );
    };

    const { jobId } = await enqueueJob('resize-image', { imageUrl: 'http://bad.example/x.jpg' });

    // The worker's update found the record, because it was written first.
    expect(failedUpdateResult).not.toBeNull();

    // Invariant: the job record reflects the true final state.
    const record = Job.docs.find((d) => d.bullJobId === jobId);
    expect(record.status).toBe('failed');
  });

  it('configures 3 attempts with 2s exponential backoff for every job', () => {
    // Set on the Queue, so jobs re-added by the sweeper get them too.
    expect(hooks.queue.opts.defaultJobOptions).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  });

  it('keeps the record queued and still returns the job id when add() fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    hooks.addError = new Error('Redis unavailable');

    const { jobId } = await enqueueJob('resize-image', { imageUrl: 'http://ok.example/x.jpg' });

    expect(jobId).toBeTruthy();
    const record = Job.docs.find((d) => d.bullJobId === jobId);
    expect(record.status).toBe('queued');
    expect(hooks.queue.jobs.size).toBe(0);
  });

  it('sweeper re-adds a stale queued job that is missing from the queue', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const payload = { imageUrl: 'http://ok.example/x.jpg', width: 300, height: 300 };
    hooks.addError = new Error('Redis unavailable');
    const { jobId } = await enqueueJob('resize-image', payload);
    delete hooks.addError;
    makeStale(jobId);

    await sweepOnce(Job, hooks.queue);

    const job = hooks.queue.jobs.get(jobId);
    expect(job).toEqual({ id: jobId, name: 'resize-image', data: payload });
  });

  it('sweeper re-adding a job the queue already holds creates no duplicate', async () => {
    const { jobId } = await enqueueJob('resize-image', { imageUrl: 'http://ok.example/x.jpg' });
    makeStale(jobId); // e.g. a backlog: still waiting in Redis after 2 minutes

    await sweepOnce(Job, hooks.queue);

    expect([...hooks.queue.jobs.keys()]).toEqual([jobId]);
    expect(Job.docs).toHaveLength(1);
  });

  it('retries once with a fresh id when the insert hits a duplicate key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    Job.createErrors.push(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }));

    const { jobId } = await enqueueJob('resize-image', { imageUrl: 'https://example.com/a.jpg' });

    expect(Job.docs).toHaveLength(1);
    expect(Job.docs[0].bullJobId).toBe(jobId);
    expect(hooks.queue.jobs.has(jobId)).toBe(true);
  });

  it('gives up after a second duplicate key and enqueues nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dup = () => Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    Job.createErrors.push(dup(), dup());

    await expect(enqueueJob('resize-image', { imageUrl: 'https://example.com/a.jpg' })).rejects.toThrow(/E11000/);
    expect(Job.docs).toHaveLength(0);
    expect(hooks.queue.jobs.size).toBe(0);
  });

  it('does not retry other database errors', async () => {
    Job.createErrors.push(new Error('MongoNetworkError'));
    await expect(enqueueJob('resize-image', { imageUrl: 'https://example.com/a.jpg' })).rejects.toThrow(
      'MongoNetworkError'
    );
    expect(Job.docs).toHaveLength(0);
  });
});

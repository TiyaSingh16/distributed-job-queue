import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

// index.js is CommonJS and loads its dependencies with plain require(), which
// vi.mock does not reliably intercept. Instead we seed Node's require cache
// with fakes before loading index.js, so its require() calls get them.
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');

function stubModule(id, exports) {
  const key = require.resolve(id);
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
}

// In-memory stand-in for the Mongoose Job model. findOneAndUpdate mirrors
// Mongoose's default (no upsert): if no document matches, it writes nothing
// and resolves to null.
function createFakeJobModel() {
  const docs = [];
  let nextId = 1;
  return {
    docs,
    async create(fields) {
      const doc = { _id: `mongo-${nextId++}`, ...fields };
      docs.push(doc);
      return doc;
    },
    async findOneAndUpdate(filter, update) {
      const doc = docs.find((d) => d.bullJobId === filter.bullJobId);
      if (!doc) return null;
      Object.assign(doc, update);
      return doc;
    },
  };
}

// Fake BullMQ Queue. add() runs `beforeAddResolves` after the job "exists in
// Redis" but before the promise returned to enqueueJob settles. This models a
// worker picking the job up and failing it while the API is still awaiting.
function createFakeBullmq(hooks) {
  let nextId = 1;
  class Queue {
    async add(name, data) {
      const job = { id: String(nextId++), name, data };
      if (hooks.beforeAddResolves) await hooks.beforeAddResolves(job);
      return job;
    }
  }
  return { Queue };
}

describe('enqueueJob', () => {
  let Job;
  let hooks;
  let enqueueJob;

  beforeEach(() => {
    Job = createFakeJobModel();
    hooks = {};
    stubModule('bullmq', createFakeBullmq(hooks));
    stubModule('mongoose', { connect: () => Promise.resolve() });
    stubModule(path.join(root, 'models.js'), Job);

    const indexPath = require.resolve(path.join(root, 'index.js'));
    delete require.cache[indexPath];
    ({ enqueueJob } = require(indexPath));
  });

  it('records a job as failed when the worker fails it before Job.create runs', async () => {
    let failedUpdateResult;

    // Sequence of events:
    //   1. API: jobQueue.add() puts job "1" in Redis.
    //   2. Worker: picks up job "1", fails fast, and its 'failed' handler runs
    //      the same update as worker.js:108. No Mongo record exists yet, so
    //      it matches nothing.
    //   3. API: add() resolves, then Job.create writes status 'queued'.
    hooks.beforeAddResolves = async (job) => {
      failedUpdateResult = await Job.findOneAndUpdate(
        { bullJobId: job.id },
        { status: 'failed', error: 'Could not download the image' }
      );
    };

    const { jobId } = await enqueueJob('resize-image', { imageUrl: 'http://bad.example/x.jpg' });

    // The worker's update was lost: it ran before the record existed.
    expect(failedUpdateResult).toBeNull();

    // Invariant: the job record reflects the true final state. BullMQ
    // considers this job failed, so the record must say 'failed'.
    // On the current code it is stuck at 'queued' and nothing will change it.
    const record = Job.docs.find((d) => d.bullJobId === jobId);
    expect(record.status).toBe('failed');
  });
});

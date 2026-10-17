import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');
const { sweepOnce, STALE_AFTER_MS } = require(path.join(root, 'sweeper.js'));

const NOW = Date.now();
const STALE = new Date(NOW - STALE_AFTER_MS - 1000);
const FRESH = new Date(NOW - 1000);
const OID = 'aaaaaaaaaaaaaaaaaaaaaaaa'; // a 24-hex ObjectId-style id

// In-memory Job model supporting the sweeper's queries:
//   find({ status: { $in }, createdAt: { $lt } })
//   findOneAndUpdate({ bullJobId, status?: { $in } }, update)
function createFakeJobModel(docs) {
  const matchesStatus = (doc, cond) => !cond || cond.$in.includes(doc.status);
  return {
    docs,
    async find(filter) {
      return docs.filter(
        (d) => matchesStatus(d, filter.status) && d.createdAt < filter.createdAt.$lt
      );
    },
    async findOneAndUpdate(filter, update) {
      const doc = docs.find(
        (d) => d.bullJobId === filter.bullJobId && matchesStatus(d, filter.status)
      );
      if (!doc) return null;
      Object.assign(doc, update);
      return doc;
    },
  };
}

// Fake BullMQ queue. `bullJobs` maps id -> { state, returnvalue, failedReason }.
// getJob resolves to undefined for unknown ids, like BullMQ. add() rejects
// integer ids exactly like BullMQ does ("Custom Id cannot be integers").
function createFakeQueue(bullJobs = {}) {
  const added = [];
  return {
    added,
    async getJob(id) {
      const j = bullJobs[id];
      if (!j) return undefined;
      return { id, returnvalue: j.returnvalue, failedReason: j.failedReason, getState: async () => j.state };
    },
    async add(name, data, opts) {
      if (`${parseInt(opts.jobId, 10)}` === opts.jobId) throw new Error('Custom Id cannot be integers');
      added.push({ name, data, opts });
    },
  };
}

function record(fields) {
  return { type: 'resize-image', payload: { imageUrl: 'https://x.example/a.jpg' }, createdAt: STALE, ...fields };
}

describe('sweeper reconciler', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('syncs a stale processing record to completed when BullMQ says completed', async () => {
    // Worker finished in BullMQ, but its Mongo write was lost (e.g. crash).
    const Job = createFakeJobModel([record({ bullJobId: OID, status: 'processing' })]);
    const queue = createFakeQueue({
      [OID]: { state: 'completed', returnvalue: { imageUrl: 'https://cdn/r.jpg', sizeKB: 12 } },
    });

    await sweepOnce(Job, queue, NOW);

    expect(Job.docs[0].status).toBe('completed');
    expect(Job.docs[0].result).toEqual({ imageUrl: 'https://cdn/r.jpg', sizeKB: 12 });
    expect(queue.added).toHaveLength(0);
  });

  it('syncs a stale queued record to failed with the BullMQ failure reason', async () => {
    const Job = createFakeJobModel([record({ bullJobId: OID, status: 'queued' })]);
    const queue = createFakeQueue({ [OID]: { state: 'failed', failedReason: 'Could not download the image' } });

    await sweepOnce(Job, queue, NOW);

    expect(Job.docs[0].status).toBe('failed');
    expect(Job.docs[0].error).toBe('Could not download the image');
    expect(queue.added).toHaveLength(0);
  });

  it("replaces BullMQ's internal stalled-job reason with a user-readable message", async () => {
    const Job = createFakeJobModel([record({ bullJobId: OID, status: 'processing' })]);
    const queue = createFakeQueue({
      [OID]: { state: 'failed', failedReason: 'job stalled more than allowable limit' },
    });

    await sweepOnce(Job, queue, NOW);

    expect(Job.docs[0].status).toBe('failed');
    expect(Job.docs[0].error).toMatch(/interrupted/);
    expect(Job.docs[0].error).not.toMatch(/stalled/);
  });

  it('marks a missing legacy numeric-id record failed instead of re-adding it', async () => {
    const Job = createFakeJobModel([record({ bullJobId: '42', status: 'processing' })]);
    const queue = createFakeQueue();

    await sweepOnce(Job, queue, NOW);

    expect(Job.docs[0].status).toBe('failed');
    expect(Job.docs[0].error).toBe('legacy record, never delivered');
    expect(queue.added).toHaveLength(0);
    expect(console.error).not.toHaveBeenCalled(); // no "Custom Id cannot be integers" loop
  });

  it('re-adds a stale record whose job is missing from BullMQ', async () => {
    const Job = createFakeJobModel([record({ bullJobId: OID, status: 'processing' })]);
    const queue = createFakeQueue();

    await sweepOnce(Job, queue, NOW);

    expect(queue.added).toEqual([
      { name: 'resize-image', data: { imageUrl: 'https://x.example/a.jpg' }, opts: { jobId: OID } },
    ]);
    expect(Job.docs[0].status).toBe('processing');
  });

  it('re-adds an ObjectId that happens to be all digits (not legacy)', async () => {
    const digits = '000000000000000000000001';
    const Job = createFakeJobModel([record({ bullJobId: digits, status: 'queued' })]);
    const queue = createFakeQueue();

    await sweepOnce(Job, queue, NOW);

    expect(queue.added.map((a) => a.opts.jobId)).toEqual([digits]);
    expect(Job.docs[0].status).toBe('queued');
  });

  it('re-adds with an empty payload when Mongoose dropped it', async () => {
    const Job = createFakeJobModel([record({ bullJobId: OID, status: 'queued', payload: undefined })]);
    const queue = createFakeQueue();

    await sweepOnce(Job, queue, NOW);

    expect(queue.added[0].data).toEqual({});
  });

  it.each(['waiting', 'active', 'delayed'])('leaves a record alone while BullMQ says %s', async (state) => {
    const Job = createFakeJobModel([record({ bullJobId: OID, status: 'processing' })]);
    const queue = createFakeQueue({ [OID]: { state } });

    await sweepOnce(Job, queue, NOW);

    expect(Job.docs[0].status).toBe('processing');
    expect(queue.added).toHaveLength(0);
  });

  it('ignores records that are not yet stale', async () => {
    const Job = createFakeJobModel([record({ bullJobId: OID, status: 'processing', createdAt: FRESH })]);
    const queue = createFakeQueue({ [OID]: { state: 'failed', failedReason: 'x' } });

    await sweepOnce(Job, queue, NOW);

    expect(Job.docs[0].status).toBe('processing');
  });

  it('never overwrites a record that reached a terminal state after it was read', async () => {
    // Sequence: sweeper reads the record as 'processing'; before it writes,
    // the worker records 'completed'. The sweeper's write must not clobber it.
    const doc = record({ bullJobId: OID, status: 'processing' });
    const Job = createFakeJobModel([doc]);
    const queue = createFakeQueue({ [OID]: { state: 'failed', failedReason: 'stale' } });
    const realGetJob = queue.getJob;
    queue.getJob = async (id) => {
      doc.status = 'completed';
      return realGetJob(id);
    };

    await sweepOnce(Job, queue, NOW);

    expect(doc.status).toBe('completed');
    expect(doc.error).toBeUndefined();
  });

  it('keeps going when one record fails to reconcile', async () => {
    const OID2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const Job = createFakeJobModel([
      record({ bullJobId: OID, status: 'queued' }),
      record({ bullJobId: OID2, status: 'queued' }),
    ]);
    const queue = createFakeQueue();
    const realGetJob = queue.getJob;
    queue.getJob = async (id) => {
      if (id === OID) throw new Error('Redis blip');
      return realGetJob(id);
    };

    await sweepOnce(Job, queue, NOW);

    expect(queue.added.map((a) => a.opts.jobId)).toEqual([OID2]);
  });
});

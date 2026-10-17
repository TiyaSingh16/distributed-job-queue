const SWEEP_INTERVAL_MS = 60 * 1000;
const STALE_AFTER_MS = 2 * 60 * 1000;

// Statuses that are not final: the record may still disagree with BullMQ.
const IN_FLIGHT = ['queued', 'processing'];

// Before the outbox change, BullMQ assigned its own auto-increment ids
// ("1", "2", ...). BullMQ refuses integer custom ids, so such a record can
// never be re-added. This is BullMQ's own test (job.js); a plain /^\d+$/
// would also match a 24-digit ObjectId, which BullMQ accepts.
function isLegacyId(id) {
  return `${parseInt(id, 10)}` === id;
}

// BullMQ's own failure reasons (e.g. "job stalled more than allowable limit"
// when a worker died mid-job) are written for operators, not users. Messages
// from the worker are already user-safe (see worker.js), so pass them through.
const INTERRUPTED =
  'Processing was interrupted (a worker restarted) and could not be completed. Please submit the image again.';

function publicFailureReason(reason) {
  if (!reason || /stalled/i.test(reason)) return INTERRUPTED;
  return reason;
}

// Write a final state, but only if the record is still in flight, so we never
// overwrite a terminal state the worker recorded after we read the record.
function finalize(Job, bullJobId, update) {
  return Job.findOneAndUpdate({ bullJobId, status: { $in: IN_FLIGHT } }, update);
}

// Bring one stale record in line with what BullMQ knows about its job.
async function reconcile(Job, queue, record) {
  const bullJob = await queue.getJob(record.bullJobId);

  if (bullJob) {
    const state = await bullJob.getState();
    if (state === 'completed') {
      const update = { status: 'completed' };
      // Jobs from older workers returned { status: 'done' }, not the result.
      if (bullJob.returnvalue && bullJob.returnvalue.imageUrl) update.result = bullJob.returnvalue;
      await finalize(Job, record.bullJobId, update);
    } else if (state === 'failed') {
      await finalize(Job, record.bullJobId, { status: 'failed', error: publicFailureReason(bullJob.failedReason) });
    }
    // Any other state (waiting, active, delayed, ...) means BullMQ still owns
    // the job and will deliver it; nothing to do.
    return;
  }

  if (isLegacyId(record.bullJobId)) {
    await finalize(Job, record.bullJobId, { status: 'failed', error: 'legacy record, never delivered' });
    return;
  }

  // BullMQ has no such job (e.g. jobQueue.add failed in enqueueJob): deliver
  // it. Reusing bullJobId as the jobId keeps this a no-op if it races with
  // another add of the same job.
  // Mongoose drops empty objects on save, so payload may be undefined.
  await queue.add(record.type, record.payload || {}, { jobId: record.bullJobId });
}

// Reconcile every record that has been in flight longer than STALE_AFTER_MS.
async function sweepOnce(Job, queue, now = Date.now()) {
  const stale = await Job.find({
    status: { $in: IN_FLIGHT },
    createdAt: { $lt: new Date(now - STALE_AFTER_MS) },
  });
  for (const record of stale) {
    try {
      await reconcile(Job, queue, record);
    } catch (err) {
      console.error(`Sweeper failed to reconcile job ${record.bullJobId}:`, err);
    }
  }
}

function startSweeper(Job, queue) {
  return setInterval(() => {
    sweepOnce(Job, queue).catch((err) => console.error('Sweeper error:', err));
  }, SWEEP_INTERVAL_MS);
}

module.exports = { sweepOnce, startSweeper, publicFailureReason, STALE_AFTER_MS };

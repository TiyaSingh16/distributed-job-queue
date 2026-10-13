const SWEEP_INTERVAL_MS = 60 * 1000;
const STALE_AFTER_MS = 2 * 60 * 1000;

// Re-add every job whose record has been 'queued' for longer than
// STALE_AFTER_MS (e.g. because jobQueue.add failed in enqueueJob). The
// record's bullJobId is reused as the BullMQ jobId, so if BullMQ still holds
// the job, the add is ignored and no duplicate is created.
async function sweepOnce(Job, queue, now = Date.now()) {
  const stale = await Job.find({
    status: 'queued',
    createdAt: { $lt: new Date(now - STALE_AFTER_MS) },
  });
  for (const record of stale) {
    try {
      // Mongoose drops empty objects on save, so payload may be undefined.
      await queue.add(record.type, record.payload || {}, { jobId: record.bullJobId });
    } catch (err) {
      console.error(`Sweeper failed to re-add job ${record.bullJobId}:`, err);
    }
  }
}

function startSweeper(Job, queue) {
  return setInterval(() => {
    sweepOnce(Job, queue).catch((err) => console.error('Sweeper error:', err));
  }, SWEEP_INTERVAL_MS);
}

module.exports = { sweepOnce, startSweeper, STALE_AFTER_MS };

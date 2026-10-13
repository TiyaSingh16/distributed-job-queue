const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  bullJobId: { type: String, required: true },
  type: { type: String, required: true },
  payload: { type: Object },
  status: { type: String, enum: ['queued', 'processing', 'completed', 'failed'], default: 'queued' },
  result: { type: Object },
  error: { type: String },
}, { timestamps: true });

// Every lookup and update goes by bullJobId; unique also guarantees one
// record per BullMQ job.
jobSchema.index({ bullJobId: 1 }, { unique: true });
// Serves the sweeper (status $in + createdAt range) and
// GET /jobs?status=... sorted by createdAt.
jobSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('Job', jobSchema);

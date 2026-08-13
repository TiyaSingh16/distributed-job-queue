const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  bullJobId: { type: String, required: true },
  type: { type: String, required: true },
  payload: { type: Object },
  status: { type: String, enum: ['queued', 'processing', 'completed', 'failed'], default: 'queued' },
  result: { type: Object },
  error: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Job', jobSchema);
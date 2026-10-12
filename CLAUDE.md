# Working rules
- I'm preparing for SDE placement interviews and must be able to explain every line of this repo.
- Default to reviewing and explaining, not writing code. Before proposing any change, state the contract/invariant the change must guarantee.
- For bugs: show me a concrete counterexample (exact sequence of events) or a failing test first. Do not write the fix unless I explicitly ask.
- You may write boilerplate directly when asked: test setup, CI config, lint config, README formatting.
- Keep each change small and focused on one concern so I can commit it separately.
- Never commit or push; I do that myself.

# Project context
- Node.js + Express API (index.js), BullMQ worker (worker.js), Mongoose model (models.js), React frontend in /frontend.
- Redis on Upstash, MongoDB Atlas, Cloudinary for image storage. API and worker deploy as separate services.
- Target guarantee: at-least-once delivery with idempotent job handling, and a job record that always reflects the true final state.

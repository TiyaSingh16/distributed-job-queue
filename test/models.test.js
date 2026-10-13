import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

// Uses the real Mongoose schema; no database connection is needed to read
// the index definitions.
const require = createRequire(import.meta.url);
const Job = require(path.join(path.resolve(__dirname, '..'), 'models.js'));

describe('Job indexes', () => {
  const indexes = Job.schema.indexes();

  it('has a unique index on bullJobId', () => {
    expect(indexes).toContainEqual([{ bullJobId: 1 }, expect.objectContaining({ unique: true })]);
  });

  it('has a compound index on { status, createdAt } for the sweeper and status-filtered listing', () => {
    // Key order matters to MongoDB and toEqual ignores it, so compare key lists.
    const keyLists = indexes.map(([fields]) => Object.entries(fields));
    expect(keyLists).toContainEqual([['status', 1], ['createdAt', 1]]);
  });
});

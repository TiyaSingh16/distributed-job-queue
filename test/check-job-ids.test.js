import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { findDuplicateBullJobIds, countLegacyIds, hasUniqueBullJobIdIndex } = require(
  path.join(path.resolve(__dirname, '..'), 'scripts', 'check-job-ids.js')
);

// Minimal collection fake that records the pipeline/filter it was given, so
// the test checks the query is read-only and shaped correctly.
function fakeCollection({ aggregateResult = [], count = 0 } = {}) {
  const calls = [];
  return {
    calls,
    aggregate(pipeline) {
      calls.push(['aggregate', pipeline]);
      return { toArray: async () => aggregateResult };
    },
    async countDocuments(filter) {
      calls.push(['countDocuments', filter]);
      return count;
    },
  };
}

describe('scripts/check-job-ids.js', () => {
  it('groups by bullJobId and keeps only values used more than once', async () => {
    const dup = [{ bullJobId: '17', count: 2, recordIds: ['a', 'b'] }];
    const collection = fakeCollection({ aggregateResult: dup });
    await expect(findDuplicateBullJobIds(collection)).resolves.toEqual(dup);

    const [, pipeline] = collection.calls[0];
    expect(pipeline[0]).toMatchObject({ $group: { _id: '$bullJobId' } });
    expect(pipeline[1]).toEqual({ $match: { count: { $gt: 1 } } });
    // No $out/$merge stage: the check must never write.
    expect(pipeline.some((stage) => '$out' in stage || '$merge' in stage)).toBe(false);
  });

  it('counts legacy numeric ids without matching 24-character ObjectId strings', async () => {
    const collection = fakeCollection({ count: 3 });
    await expect(countLegacyIds(collection)).resolves.toBe(3);
    const { bullJobId } = collection.calls[0][1];
    expect(bullJobId.$regex.test('17')).toBe(true);
    expect(bullJobId.$regex.test('6a7c6413b07ec8a5b526a7d7')).toBe(false);
    expect(bullJobId.$regex.test('123456789012345678901234')).toBe(false);
  });

  it('detects the unique bullJobId index', () => {
    expect(hasUniqueBullJobIdIndex([{ key: { _id: 1 } }, { key: { bullJobId: 1 }, unique: true }])).toBe(true);
    expect(hasUniqueBullJobIdIndex([{ key: { bullJobId: 1 } }])).toBe(false);
    expect(hasUniqueBullJobIdIndex([])).toBe(false);
  });
});

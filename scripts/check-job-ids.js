#!/usr/bin/env node
// Read-only check of the jobs collection before (or after) deploying the
// unique index on bullJobId declared in models.js.
//
//   MONGO_URI="mongodb+srv://..." node scripts/check-job-ids.js
//
// Reports:
//   - bullJobId values shared by more than one record (these block the
//     unique index from being built),
//   - how many records still use legacy numeric ids from before ids were
//     ObjectIds,
//   - whether the unique index exists.
// It never writes, updates or deletes anything. Exit code: 0 if no
// duplicates, 1 if duplicates were found, 2 on a connection/usage error.

require('dotenv').config();
const mongoose = require('mongoose');

async function findDuplicateBullJobIds(collection, { sampleSize = 5 } = {}) {
  return collection
    .aggregate([
      { $group: { _id: '$bullJobId', count: { $sum: 1 }, recordIds: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
      { $project: { _id: 0, bullJobId: '$_id', count: 1, recordIds: { $slice: ['$recordIds', sampleSize] } } },
    ])
    .toArray();
}

async function countLegacyIds(collection) {
  // Pre-outbox records used BullMQ's auto-increment ids: "1", "2", ...
  return collection.countDocuments({ bullJobId: { $regex: /^[0-9]{1,15}$/ } });
}

function hasUniqueBullJobIdIndex(indexes) {
  return indexes.some((ix) => ix.unique && Object.keys(ix.key).join(',') === 'bullJobId');
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('Set MONGO_URI (same value as the API service) and run again.');
    return 2;
  }
  await mongoose.connect(uri, { autoIndex: false });
  try {
    const collection = mongoose.connection.db.collection('jobs');
    const total = await collection.estimatedDocumentCount();
    const duplicates = await findDuplicateBullJobIds(collection);
    const legacy = await countLegacyIds(collection);
    const indexes = await collection.indexes().catch(() => []);

    console.log(`Records in jobs: ${total}`);
    console.log(`Records with legacy numeric bullJobId: ${legacy}`);
    console.log(`Unique index on bullJobId present: ${hasUniqueBullJobIdIndex(indexes) ? 'yes' : 'no'}`);
    if (duplicates.length === 0) {
      console.log('Duplicate bullJobIds: none. The unique index can be built.');
      return 0;
    }
    console.log(`Duplicate bullJobIds: ${duplicates.length} value(s) shared by more than one record:`);
    for (const d of duplicates) {
      console.log(`  bullJobId ${JSON.stringify(d.bullJobId)}: ${d.count} records, e.g. _id ${d.recordIds.join(', ')}`);
    }
    console.log('The unique index cannot be built until each bullJobId is used by one record. Nothing was changed.');
    return 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('Check failed:', err.message);
      process.exit(2);
    }
  );
}

module.exports = { findDuplicateBullJobIds, countLegacyIds, hasUniqueBullJobIdIndex };

// Unique indexes left in the database by older versions of the app that no longer match the code — and that break it.
// Mongoose creates the indexes a schema defines but never removes old ones, so they have to be dropped explicitly.
//  - metaleadstatuses { nameKey: 1 }: a status name unique across ALL companies (from before companies had their own
//    statuses). Every company after the first got no default statuses and could not add "Callback", "Lost"… The
//    per-company index { company: 1, nameKey: 1 } stays.
//  - metaintegrations / googleadsintegrations { key: 1 }: unique on a field the code no longer writes, so the second
//    company to connect Meta / set up Google Ads failed (two documents without `key` count as duplicates).
// Each index is dropped only if it still has exactly that definition. Runs at every start; does nothing once gone.
import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

export const STALE_UNIQUE_INDEXES = [
  { collection: 'metaleadstatuses', key: { nameKey: 1 } },
  { collection: 'metaintegrations', key: { key: 1 } },
  { collection: 'googleadsintegrations', key: { key: 1 } },
];

const sameKey = (a, b) => JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));

export async function dropStaleIndexes(db = mongoose.connection.db) {
  const dropped = [];
  for (const { collection, key } of STALE_UNIQUE_INDEXES) {
    let indexes;
    try {
      indexes = await db.collection(collection).indexes();
    } catch {
      continue; // the collection doesn't exist yet
    }
    for (const index of indexes) {
      if (!index.unique || !sameKey(index.key, key)) continue;
      await db.collection(collection).dropIndex(index.name);
      dropped.push(`${collection}.${index.name}`);
    }
  }
  if (dropped.length) logger.info('Dropped stale unique indexes', { dropped });
  return dropped;
}

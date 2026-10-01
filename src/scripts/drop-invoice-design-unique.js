// One-time: allow multiple invoices per proposal (drops legacy unique index on `design`).
//   node --env-file-if-exists=.env src/scripts/drop-invoice-design-unique.js
import mongoose from 'mongoose';
import { env } from '../config/env.js';

await mongoose.connect(env.mongoUri);
const col = mongoose.connection.db.collection('invoices');
for (const idx of await col.indexes()) {
  if (idx.unique && idx.key?.design === 1 && Object.keys(idx.key).length === 1) {
    await col.dropIndex(idx.name);
    console.log(`Dropped index ${idx.name}`);
  }
}
await mongoose.disconnect();
console.log('Done.');

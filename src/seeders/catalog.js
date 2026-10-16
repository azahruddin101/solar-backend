// npm run seed:catalog                     a ready catalog for every company that has no categories yet
// npm run seed:catalog -- <companyId>…     only these companies
// Companies that already have categories are never changed.
import mongoose from 'mongoose';
import { connectDb } from '../config/db.js';
import { Company } from '../models/index.js';
import { seedCatalog } from './catalog.seeder.js';

try {
  const db = await connectDb();
  console.log(`MongoDB connected: ${db.name}`);
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const companies = await Company.find(ids.length ? { _id: { $in: ids } } : {}).select('name').lean();
  for (const c of companies) {
    const done = await seedCatalog(c._id);
    console.log(done ? `  + ${c.name}: ${done.categories} categories, ${done.products} products, ${done.packages} packages` : `  = ${c.name} (already has categories, skipped)`);
  }
} catch (e) {
  console.error(`Catalog seeding failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

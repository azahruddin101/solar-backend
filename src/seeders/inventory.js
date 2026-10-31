// npm run seed:inventory                       a large, varied inventory for the showcase company (demo@suryashakti.in)
// npm run seed:inventory -- --company=<id>     …for another company (its id, or its owner's sign-in email)
// npm run seed:inventory -- --dry-run           print what would be added, write nothing
// npm run seed:inventory -- --reset             remove what this seed added earlier, then seed again
// Re-running adds only what is missing (suppliers by name, products by SKU, batches by batch number).
import mongoose from 'mongoose';
import { connectDb } from '../config/db.js';
import { env, redactMongoUri } from '../config/env.js';
import { Company, User } from '../models/index.js';
import { SHOWCASE_LOGIN } from './data/showcase.js';
import { resetInventory, seedInventory } from './inventory.seeder.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') || '';

async function targetCompany() {
  const wanted = option('company') || SHOWCASE_LOGIN.email;
  if (/^[0-9a-f]{24}$/i.test(wanted)) return Company.findById(wanted).select('name').lean();
  const user = await User.findOne({ email: wanted.toLowerCase() }).select('company').lean();
  return user?.company ? Company.findById(user.company).select('name').lean() : null;
}

try {
  const db = await connectDb();
  console.log(`MongoDB connected: ${redactMongoUri(env.mongoUri)} (${db.name})`);
  const company = await targetCompany();
  if (!company) throw new Error(`No company for ${option('company') || SHOWCASE_LOGIN.email}. Pass --company=<id or owner email>.`);
  const dryRun = flag('dry-run');
  console.log(`${dryRun ? 'Would seed' : 'Seeding'} inventory for ${company.name}`);
  if (flag('reset')) {
    if (dryRun) throw new Error('--reset cannot be combined with --dry-run');
    console.log('Removing what the seed added earlier');
    await resetInventory(company._id);
  }
  const s = await seedInventory(company._id, { dryRun });
  console.log(`\n${dryRun ? 'Would add' : 'Added'}: ${s.suppliers} suppliers, ${s.categories} categories, ${s.products} products, ${s.batches} receipts (batches), ${s.units} serial units`);
  console.log(`Already there, left alone: ${s.skipped.suppliers} suppliers, ${s.skipped.products} products, ${s.skipped.batches} batches`);
} catch (e) {
  console.error(`Inventory seeding failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

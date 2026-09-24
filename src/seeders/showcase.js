// npm run seed:showcase [-- --replace]
import mongoose from 'mongoose';
import { connectDb } from '../config/db.js';
import { DEMO_PASSWORD } from './data/companies.js';
import { SHOWCASE_AGENTS, SHOWCASE_LOGIN } from './data/showcase.js';
import { assertSeedAllowed } from './guard.js';
import { ensureSuperAdmin } from './superAdmin.seeder.js';
import { seedShowcase } from './showcase.seeder.js';

try {
  assertSeedAllowed();
  const db = await connectDb();
  console.log(`MongoDB connected: ${db.name}`);
  await ensureSuperAdmin();
  const created = await seedShowcase({ replace: process.argv.includes('--replace') });
  if (created) {
    console.log('\nSign-ins (password for all: ' + DEMO_PASSWORD + ')');
    console.log(`  Company  ${SHOWCASE_LOGIN.email}  (${SHOWCASE_LOGIN.name})`);
    for (const a of SHOWCASE_AGENTS) console.log(`  Agent    ${a.email}  (${a.name} · ${a.roles.join(', ')})`);
  }
} catch (e) {
  console.error(`Showcase seeding failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

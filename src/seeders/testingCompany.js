import mongoose from 'mongoose';
import { connectDb } from '../config/db.js';
import {
  TESTING_EXTRA_BRANCHES,
  TESTING_MAIN_BRANCH,
  TESTING_ORG_ADMIN,
  TESTING_PASSWORD,
} from './data/testingCompany.js';
import { assertSeedAllowed } from './guard.js';
import { ensureSuperAdmin } from './superAdmin.seeder.js';
import { seedTestingCompany } from './testingCompany.seeder.js';

try {
  assertSeedAllowed();
  const db = await connectDb();
  console.log(`MongoDB connected: ${db.name}`);
  await ensureSuperAdmin();
  console.log('Testing company (multi-branch QA tenant)');
  const created = await seedTestingCompany({ replace: process.argv.includes('--replace') });
  if (created) {
    console.log('\nSign-ins (password for all accounts below):');
    console.log(`  ${TESTING_PASSWORD}`);
    console.log(`  Company admin   ${TESTING_ORG_ADMIN.email}  →  /org`);
    console.log(`  Branch owner    ${TESTING_MAIN_BRANCH.owner.email}  →  ${TESTING_MAIN_BRANCH.name}`);
    for (const b of TESTING_EXTRA_BRANCHES) {
      console.log(`  Branch owner    ${b.ownerEmail}  →  ${b.name}`);
    }
    console.log('  Staff           *@testingcompany.test  (same password, one set per branch)');
  }
} catch (e) {
  console.error(`Testing seed failed: ${e.message}`);
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

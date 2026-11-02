// Seed the database:  npm run seed         add what is missing (safe to re-run)
//                     npm run seed:fresh   wipe the database and uploads first
import { promises as fs } from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { connectDb } from '../config/db.js';
import { env } from '../config/env.js';
import { seedDemoData } from './demo.seeder.js';
import { COMPANIES, DEMO_PASSWORD } from './data/companies.js';
import { assertSeedAllowed } from './guard.js';
import { ensureSuperAdmin } from './superAdmin.seeder.js';

const fresh = process.argv.includes('--fresh');

try {
  assertSeedAllowed();
  const db = await connectDb();
  console.log(`MongoDB connected: ${db.name}`);

  if (fresh) {
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to wipe a production database (NODE_ENV=production).');
    await db.dropDatabase();
    for (const file of await fs.readdir(env.uploadDir).catch(() => [])) if (file !== '.gitkeep') await fs.rm(path.join(env.uploadDir, file), { force: true, recursive: true }); // incl. uploads/reports
    console.log('Database and uploads wiped.');
  }

  console.log('Super admin');
  await ensureSuperAdmin();
  console.log('Demo companies');
  await seedDemoData();

  console.log(`\nSign-ins (demo password: ${DEMO_PASSWORD})`);
  console.log(`  Super admin     ${env.superAdminEmail}  /  ${env.superAdminPassword}`);
  for (const c of COMPANIES) {
    const suspended = c.company.status === 'suspended' ? '  (suspended)' : '';
    if (c.hasBranches) {
      console.log(`  Company admin   ${c.login.email}  /  ${DEMO_PASSWORD}  →  /org  (${c.company.name})${suspended}`);
      console.log(`  Branch owner    ${c.branchOwner.email}  /  ${DEMO_PASSWORD}  →  ${c.branchName}`);
    } else {
      console.log(`  Owner           ${c.login.email}  /  ${DEMO_PASSWORD}  →  /dashboard  (${c.company.name}, no branches)${suspended}`);
    }
    if (c.extraBranches?.length) {
      for (const b of c.extraBranches) {
        if (b.ownerEmail) console.log(`  Branch owner    ${b.ownerEmail}  /  ${DEMO_PASSWORD}  →  ${b.name}`);
      }
    }
    if (c.agents?.length) {
      for (const a of c.agents) {
        console.log(`    Staff         ${a.email}  /  ${DEMO_PASSWORD} (${a.name})`);
      }
    }
  }
} catch (e) {
  console.error(`Seeding failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

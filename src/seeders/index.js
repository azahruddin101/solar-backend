// Seed the database:  npm run seed         add what is missing (safe to re-run)
//                     npm run seed:fresh   wipe the database and uploads first
import { promises as fs } from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { connectDb } from '../config/db.js';
import { env } from '../config/env.js';
import { seedDemoData } from './demo.seeder.js';
import { COMPANIES, DEMO_PASSWORD } from './data/companies.js';
import { ensureSuperAdmin } from './superAdmin.seeder.js';

const fresh = process.argv.includes('--fresh');

try {
  const db = await connectDb();
  console.log(`MongoDB connected: ${db.name}`);

  if (fresh) {
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to wipe a production database (NODE_ENV=production).');
    await db.dropDatabase();
    for (const file of await fs.readdir(env.uploadDir).catch(() => [])) if (file !== '.gitkeep') await fs.rm(path.join(env.uploadDir, file), { force: true });
    console.log('Database and uploads wiped.');
  }

  console.log('Super admin');
  await ensureSuperAdmin();
  console.log('Demo companies');
  await seedDemoData();

  console.log('\nSign-ins');
  console.log(`  Super admin  ${env.superAdminEmail}  (password: SUPERADMIN_PASSWORD in backend/.env)`);
  for (const c of COMPANIES) console.log(`  Company      ${c.login.email}  /  ${DEMO_PASSWORD}${c.company.status === 'suspended' ? '  (suspended)' : ''}`);
} catch (e) {
  console.error(`Seeding failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

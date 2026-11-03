// Old unique indexes that are not per company broke every company after the first (no lead statuses, "already
// exists" on a status nobody had, a second Meta / Google Ads connection failing). The start-up migration removes exactly
// those and keeps the correct per-company ones; default statuses then appear for every company.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.S3_BUCKET = '';
process.env.JWT_SECRET ||= 'test-only-secret';
const require = createRequire(import.meta.url);

const { Company } = await import('../src/models/index.js');
const { dropStaleIndexes } = await import('../src/migrations/staleIndexes.migration.js');
const { startLeadsApp, mkUser, MetaLeadStatus } = await import('./helpers/leadsApp.js');
const MetaIntegration = require('../leads-integration/models/MetaIntegration.js');

let server, leads;
before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  leads = await startLeadsApp();
});
after(async () => {
  await leads?.stop();
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  // init() only runs once per model: recreate the schema's indexes after dropping the database
  for (const n of mongoose.modelNames()) await mongoose.model(n).createIndexes();
  // what production still had: the old cross-company unique indexes
  await MetaLeadStatus.collection.createIndex({ nameKey: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
  await MetaIntegration.collection.createIndex({ key: 1 }, { unique: true });
});

async function owner(name) {
  const company = await Company.create({ name });
  return { company, user: await mkUser(company, { role: 'branch' }) };
}
const statusNames = async (company) => (await MetaLeadStatus.find({ company: company._id, isDeleted: false })).map((s) => s.name).sort();

test('with the old indexes, a second company gets no statuses and "Callback" already exists (the production bug)', async () => {
  const a = await owner('First Solar');
  const b = await owner('Second Solar');
  await leads.as(a.user, a.company);
  assert.equal((await leads.call('GET', '/api/leads/statuses')).body.length, 6);
  await leads.as(b.user, b.company);
  const res = await leads.call('GET', '/api/leads/statuses'); // now fails loudly instead of an empty list
  assert.notEqual(res.status, 200);
  assert.deepEqual(await statusNames(b.company), []);
});

test('the migration drops exactly the stale indexes; every company then gets its statuses', async () => {
  const dropped = await dropStaleIndexes();
  assert.deepEqual(dropped.sort(), ['metaintegrations.key_1', 'metaleadstatuses.nameKey_1']);
  const names = (await MetaLeadStatus.collection.indexes()).map((i) => i.name);
  assert.ok(names.includes('company_1_nameKey_1'), 'the per-company unique index must stay');
  assert.deepEqual(await dropStaleIndexes(), []); // nothing left to do on the next start

  const a = await owner('First Solar');
  const b = await owner('Second Solar');
  for (const x of [a, b]) {
    await leads.as(x.user, x.company);
    assert.equal((await leads.call('GET', '/api/leads/statuses')).status, 200);
  }
  assert.deepEqual(await statusNames(b.company), ['Callback', 'Converted', 'Interested', 'Lost', 'New', 'Site visit']);
  // a name is still unique within one company
  await leads.as(b.user, b.company);
  const dup = await leads.call('POST', '/api/company/integrations/meta/lead-statuses', { name: 'Callback' });
  assert.equal(dup.status, 400);
  assert.match(dup.body.message, /already exists/);

  // two companies can both connect Meta
  await MetaIntegration.create({ company: a.company._id });
  await MetaIntegration.create({ company: b.company._id });
});

test('owners see switched-off statuses (to turn them back on); staff only the active ones', async () => {
  await dropStaleIndexes();
  const { company, user } = await owner('Solar');
  const staff = await mkUser(company, { role: 'agent', permissions: ['leads:view'] });
  await leads.as(user, company);
  await leads.call('GET', '/api/leads/statuses');
  await MetaLeadStatus.updateOne({ company: company._id, nameKey: 'callback' }, { $set: { isActive: false } });
  assert.equal((await leads.call('GET', '/api/leads/statuses')).body.length, 6);
  await leads.as(staff, company);
  assert.equal((await leads.call('GET', '/api/leads/statuses')).body.length, 5);
});

test('company owners (role branch) manage lead statuses and integrations; staff cannot', async () => {
  await dropStaleIndexes();
  const { company, user } = await owner('Solar');
  const staff = await mkUser(company, { role: 'agent', permissions: ['leads:view', 'leads:change_status'] });
  await leads.as(user, company);
  const created = await leads.call('POST', '/api/company/integrations/meta/lead-statuses', { name: 'Follow up' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await leads.call('GET', '/api/company/integrations/meta/lead-statuses')).status, 200);
  assert.notEqual((await leads.call('GET', '/api/company/integrations/sheet')).status, 403);
  await leads.as(staff, company);
  assert.equal((await leads.call('POST', '/api/company/integrations/meta/lead-statuses', { name: 'Mine' })).status, 403);
});

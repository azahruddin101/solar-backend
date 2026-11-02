// The automatic Meta lead sync (leads-integration/services/metaAutoSync.js): every few hours each company with a
// working Meta connection gets one sync of its lead forms, reading only what is new since the last good sync.
// The schedule lives in the database, so restarts don't reset it and several server processes queue each run once.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.S3_BUCKET = '';
// a throwaway key for the encrypted Meta secrets; never the real Meta app from the environment
process.env.JWT_SECRET ||= 'test-only-secret-for-meta-auto-sync';
delete process.env.META_APP_ID;
delete process.env.META_APP_SECRET;
const require = createRequire(import.meta.url);

const { Company, Organization } = await import('../src/models/index.js');
const MetaIntegration = require('../leads-integration/models/MetaIntegration.js');
const MetaSyncJob = require('../leads-integration/models/MetaSyncJob.js');
const MetaLead = require('../leads-integration/models/MetaLead.js');
const { encryptToken } = require('../leads-integration/utils/metaCrypto.js');
const { AUTO_SYNC_SETTINGS, queueDueMetaSyncs, nextAutoSyncAt } = require('../leads-integration/services/metaAutoSync.js');
const { processPendingSyncJobs, SYNC_SETTINGS } = require('../leads-integration/workers/metaSyncWorker.js');

const HOUR = 60 * 60 * 1000;
let server;
before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Promise.all([MetaSyncJob.init(), MetaIntegration.init(), MetaLead.init()]);
  AUTO_SYNC_SETTINGS.intervalMs = 3 * HOUR;
  Object.assign(SYNC_SETTINGS, { pageDelayMs: 0, retryDelaysMs: [] });
});
after(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await Promise.all([Company, Organization, MetaIntegration, MetaSyncJob, MetaLead].map((M) => M.deleteMany({})));
});
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function connectedCompany({ name = 'Sunrise', status = 'active', orgStatus = 'active', ...integration } = {}) {
  const org = await Organization.create({ name, status: orgStatus });
  const company = await Company.create({ name, organization: org._id, status });
  await MetaIntegration.create({
    company: company._id,
    connected: true,
    appSettings: { appId: '1234', appSecretEncrypted: encryptToken('app-secret'), apiBaseUrl: 'https://api.example.com/api' },
    pages: [{ pageId: 'p1', pageName: 'Sunrise Page', accessTokenEncrypted: encryptToken('page-token') }],
    selectedPageId: 'p1',
    forms: [{ formId: 'f1', formName: 'Rooftop enquiry' }],
    ...integration,
  });
  return company;
}

test('a connected company gets one scheduled sync; asking again within 3 hours queues nothing', async () => {
  const company = await connectedCompany();
  const now = new Date();
  assert.equal(await queueDueMetaSyncs(now), 1);
  const job = await MetaSyncJob.findOne({ company: company._id });
  assert.equal(job.trigger, 'scheduled');
  assert.equal(job.since, null); // never synced before: everything Meta still keeps
  assert.deepEqual(job.forms.map((f) => f.formId), ['f1']);

  await MetaSyncJob.updateOne({ _id: job._id }, { $set: { status: 'completed', startedAt: now, activeKey: undefined } });
  assert.equal(await queueDueMetaSyncs(new Date(now.getTime() + 2 * HOUR)), 0);
  assert.equal(await MetaSyncJob.countDocuments(), 1);
});

test('after the interval it reads only what is new since the last good sync, with an overlap', async () => {
  const company = await connectedCompany();
  const t0 = new Date(Date.now() - 4 * HOUR);
  await MetaSyncJob.create({ company: company._id, status: 'completed', pageId: 'p1', forms: [{ formId: 'f1', status: 'completed' }], startedAt: t0, createdAt: t0 });

  assert.equal(await queueDueMetaSyncs(), 1);
  const job = await MetaSyncJob.findOne({ trigger: 'scheduled' });
  assert.equal(job.since.getTime(), t0.getTime() - AUTO_SYNC_SETTINGS.overlapMs);
});

test('a new lead form, or a last sync where a form failed, means reading the whole history again', async () => {
  const company = await connectedCompany({ forms: [{ formId: 'f1' }, { formId: 'f2', formName: 'New form' }] });
  const t0 = new Date(Date.now() - 4 * HOUR);
  await MetaSyncJob.create({ company: company._id, status: 'completed', pageId: 'p1', forms: [{ formId: 'f1', status: 'completed' }], startedAt: t0, createdAt: t0 });
  await queueDueMetaSyncs();
  assert.equal((await MetaSyncJob.findOne({ trigger: 'scheduled' })).since, null);

  await MetaSyncJob.deleteMany({});
  await MetaIntegration.updateOne({}, { $set: { autoSyncQueuedAt: null } });
  await MetaSyncJob.create({ company: company._id, status: 'completed', formsFailed: 1, pageId: 'p1', forms: [{ formId: 'f1' }, { formId: 'f2' }], startedAt: t0, createdAt: t0 });
  await queueDueMetaSyncs();
  assert.equal((await MetaSyncJob.findOne({ trigger: 'scheduled' })).since, null);
});

test('several server processes ticking at the same moment queue the run exactly once', async () => {
  await connectedCompany();
  const now = new Date();
  const results = await Promise.all(Array.from({ length: 6 }, () => queueDueMetaSyncs(now)));
  assert.equal(results.reduce((a, n) => a + n, 0), 1);
  assert.equal(await MetaSyncJob.countDocuments(), 1);
});

test('never overlaps a sync already running, and a manual sync resets the clock', async () => {
  const company = await connectedCompany();
  // a manual "Sync Previous Leads" started 5 hours ago is still running (activeKey held)
  const old = new Date(Date.now() - 5 * HOUR);
  await MetaSyncJob.create({ company: company._id, activeKey: `active:${company._id}`, status: 'processing', pageId: 'p1', forms: [{ formId: 'f1' }], createdAt: old });
  assert.equal(await queueDueMetaSyncs(), 0);
  assert.equal(await MetaSyncJob.countDocuments(), 1);

  // a manual sync made 1 hour ago: the next automatic one is due 3 hours after it
  await MetaSyncJob.deleteMany({});
  await MetaIntegration.updateOne({}, { $set: { autoSyncQueuedAt: null } });
  const recent = new Date(Date.now() - HOUR);
  await MetaSyncJob.create({ company: company._id, status: 'completed', pageId: 'p1', forms: [{ formId: 'f1' }], createdAt: recent, startedAt: recent });
  assert.equal(await queueDueMetaSyncs(), 0);
  assert.equal((await nextAutoSyncAt(company._id)).getTime(), recent.getTime() + 3 * HOUR);
});

test('skips connections that cannot sync and companies that are suspended', async () => {
  await connectedCompany({ name: 'Reconnect', needsReconnect: true });
  await connectedCompany({ name: 'No forms', forms: [] });
  await connectedCompany({ name: 'No page', selectedPageId: null });
  await connectedCompany({ name: 'No app', appSettings: {} });
  await connectedCompany({ name: 'Disconnected', connected: false });
  await connectedCompany({ name: 'Suspended', status: 'suspended' });
  await connectedCompany({ name: 'Org suspended', orgStatus: 'suspended' });
  assert.equal(await queueDueMetaSyncs(), 0);
  assert.equal(await MetaSyncJob.countDocuments(), 0);
});

test('turned off with META_AUTO_SYNC_HOURS=0', async () => {
  await connectedCompany();
  const saved = AUTO_SYNC_SETTINGS.intervalMs;
  AUTO_SYNC_SETTINGS.intervalMs = 0;
  try {
    assert.equal(await queueDueMetaSyncs(), 0);
    assert.equal(await nextAutoSyncAt(new mongoose.Types.ObjectId()), null);
  } finally {
    AUTO_SYNC_SETTINGS.intervalMs = saved;
  }
});

test('end to end: the scheduled job asks Meta only for new leads and stores them once', async () => {
  const company = await connectedCompany();
  const t0 = new Date(Date.now() - 4 * HOUR);
  await MetaSyncJob.create({ company: company._id, status: 'completed', pageId: 'p1', forms: [{ formId: 'f1', status: 'completed' }], startedAt: t0, createdAt: t0 });
  await MetaLead.create({ company: company._id, source: 'META', externalLeadId: '111', pageId: 'p1', formId: 'f1', processingStatus: 'processed' });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url));
    const lead = (id, name) => ({ id, created_time: new Date().toISOString(), field_data: [{ name: 'full_name', values: [name] }, { name: 'phone_number', values: ['+919800000000'] }] });
    return { ok: true, status: 200, json: async () => ({ data: [lead('111', 'Already here'), lead('222', 'New Lead')], paging: {} }) };
  };

  assert.equal(await queueDueMetaSyncs(), 1);
  await processPendingSyncJobs();

  const job = await MetaSyncJob.findOne({ trigger: 'scheduled' });
  assert.equal(job.status, 'completed');
  assert.equal(job.leadsImported, 1);
  assert.equal(job.duplicatesSkipped, 1);
  assert.equal(job.activeKey, undefined); // released for the next run

  const filtering = JSON.parse(calls[0].searchParams.get('filtering'));
  assert.equal(calls[0].pathname.endsWith('/f1/leads'), true);
  assert.deepEqual(filtering, [{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor((t0.getTime() - AUTO_SYNC_SETTINGS.overlapMs) / 1000) }]);
  assert.equal(await MetaLead.countDocuments({ company: company._id }), 2);
});

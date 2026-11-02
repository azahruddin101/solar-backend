// Leads behaviour that must hold (bug audit group 4):
//  - quick assign skips converted leads instead of jamming on them;
//  - leads a team manager adds stay theirs (visible);
//  - the Google Sheet is refreshed after every kind of lead write, including bulk ones;
//  - the Google Ads integration page counts the company's leads;
//  - the board keeps leads whose status was deleted;
//  - "include past assignments" works for scoped staff.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.S3_BUCKET = '';
process.env.JWT_SECRET ||= 'test-only-secret';
delete process.env.NODE_ENV; // the sheet scheduler is switched off under NODE_ENV=test; here it is observed instead
const require = createRequire(import.meta.url);

const { Company } = await import('../src/models/index.js');
const { startLeadsApp, mkUser, ManualLead, GoogleLead, MetaLead, MetaLeadStatus } = await import('./helpers/leadsApp.js');
const sheetSync = require('../leads-integration/services/googleSheetSync.js');
const googleAds = require('../leads-integration/controllers/googleAdsIntegrationController.js');

const sheetCalls = [];
sheetSync.scheduleLeadSheetSync = (companyId) => sheetCalls.push(String(companyId)); // observed, never posted

let server, leads;
before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  leads = await startLeadsApp();
});
after(async () => {
  await leads?.stop();
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  sheetCalls.length = 0;
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
let phone = 9000000000;
const manualLead = (company, extra = {}) => {
  phone += 1;
  return ManualLead.create({ company: company._id, source: 'manual', fullName: 'Lead', phone: String(phone), phoneKey: String(phone), ...extra });
};

async function setup() {
  const company = await Company.create({ name: 'Co' });
  const owner = await mkUser(company, { role: 'branch' });
  await leads.as(owner, company);
  await leads.call('GET', '/api/leads/statuses'); // creates the default statuses
  return { company, owner };
}

test('quick assign skips converted leads (oldest first) instead of failing on them', async () => {
  const { company, owner } = await setup();
  const converted = await MetaLeadStatus.findOne({ company: company._id, outcome: 'converted' });
  const staff = await mkUser(company, { role: 'agent', permissions: ['leads:view'] });
  const oldest = await manualLead(company, { createdAt: new Date('2026-01-01') });
  await manualLead(company);
  await GoogleLead.create({ company: company._id, externalLeadId: 'g1', formId: 'f1' });
  await leads.as(owner, company);
  assert.equal((await leads.call('PUT', `/api/leads/manual/${oldest._id}/status`, { statusId: String(converted._id) })).status, 200);

  assert.equal((await leads.call('GET', '/api/leads/manual/unassigned-count')).body.unassigned, 1);
  const one = await leads.call('POST', '/api/leads/manual/assign-unassigned', { counsellorId: String(staff._id), count: 1 });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.ok(!(await ManualLead.findById(oldest._id)).assignedTo); // the converted lead was left alone

  const all = await leads.call('POST', '/api/leads/all/assign-unassigned', { counsellorId: String(staff._id), count: 1 });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(await GoogleLead.countDocuments({ assignedTo: staff._id }), 1);
});

test('a team manager keeps (and sees) the leads they add', async () => {
  const { company } = await setup();
  const mgr = await mkUser(company, { role: 'agent', permissions: ['leads:view_team', 'leads:view', 'leads:create'] });
  await mkUser(company, { role: 'agent', manager: mgr._id, permissions: ['leads:view'] });
  await leads.as(mgr, company);
  const created = await leads.call('POST', '/api/leads/manual', { name: 'Ravi', phone: '9876543210' });
  assert.equal(created.status, 201);
  assert.equal(String(created.body.assignedTo?._id ?? created.body.assignedTo?.id ?? created.body.assignedTo), String(mgr._id));
  assert.equal((await leads.call('GET', '/api/leads/manual')).body.total, 1);
});

test('the Google Sheet is refreshed after assignments, Meta processing and bulk imports', async () => {
  const { company, owner } = await setup();
  const staff = await mkUser(company, { role: 'agent', permissions: ['leads:view'] });
  const lead = await manualLead(company);
  await tick();
  sheetCalls.length = 0;

  await leads.as(owner, company);
  await leads.call('POST', '/api/leads/manual/assign', { leadIds: [String(lead._id)], counsellorId: String(staff._id) });
  await tick();
  assert.ok(sheetCalls.includes(String(company._id)), 'assignment (bulkWrite) did not refresh the sheet');

  sheetCalls.length = 0;
  const meta = await MetaLead.create({ company: company._id, externalLeadId: '555', processingStatus: 'pending', pageId: '1', formId: '2' });
  await tick();
  sheetCalls.length = 0;
  // what the Meta worker writes once a webhook lead is fetched (filter includes the company)
  await MetaLead.updateOne({ _id: meta._id, company: company._id }, { $set: { processingStatus: 'processed', fullName: 'From Meta' } });
  await tick();
  assert.ok(sheetCalls.includes(String(company._id)), 'Meta processing did not refresh the sheet');
});

test('the Google Ads integration page counts this company’s leads and forms', async () => {
  const { company } = await setup();
  await GoogleLead.create({ company: company._id, externalLeadId: 'g9', formId: 'f1', isTest: false });
  let out;
  await googleAds.getGoogleAdsIntegration({ leadsCompanyId: String(company._id) }, { json: (body) => { out = body; }, status() { return this; } });
  assert.equal(out.leads, 1);
  assert.equal(out.forms.length, 1);
});

test('the board keeps leads whose status was deleted, in a read-only column', async () => {
  const { company, owner } = await setup();
  const callback = await MetaLeadStatus.findOne({ company: company._id, nameKey: 'callback' });
  await manualLead(company, { status: callback._id, statusName: 'Callback' });
  await MetaLeadStatus.updateOne({ _id: callback._id }, { $set: { isDeleted: true, isActive: false } });
  await leads.as(owner, company);
  const board = (await leads.call('GET', '/api/leads/board')).body;
  const cards = board.columns.reduce((n, c) => n + c.leads.length, 0);
  assert.equal(board.total, 1);
  assert.equal(cards, 1);
  const column = board.columns.find((c) => c.leads.length);
  assert.match(column.name, /deleted/);
  assert.equal(column.isActive, false);
});

test('"include past assignments" works for a team manager', async () => {
  const { company, owner } = await setup();
  const mgr = await mkUser(company, { role: 'agent', permissions: ['leads:view_team', 'leads:view'] });
  const r1 = await mkUser(company, { role: 'agent', manager: mgr._id, permissions: ['leads:view'] });
  const r2 = await mkUser(company, { role: 'agent', manager: mgr._id, permissions: ['leads:view'] });
  const handed = await manualLead(company);
  await manualLead(company, { assignedTo: r2._id });
  await leads.as(owner, company);
  for (const to of [r1, r2]) await leads.call('POST', '/api/leads/manual/assign', { leadIds: [String(handed._id)], counsellorId: String(to._id) });

  await leads.as(mgr, company);
  assert.equal((await leads.call('GET', `/api/leads/manual?assignedTo=${r1._id}`)).body.total, 0); // r1 holds nothing now
  assert.equal((await leads.call('GET', `/api/leads/manual?assignedTo=${r1._id}&includePast=1`)).body.total, 1); // what r1 held before
  assert.equal((await leads.call('GET', `/api/leads/all?assignedTo=${r1._id}&includePast=1`)).body.total, 1);
});

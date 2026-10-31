// Every dashboard count links to a filtered list (`?show=…`, `?unread=1`); the list must show exactly what was counted.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const { Client, ClientTicket, Company, Design, Loan, Project, User } = await import('../src/models/index.js');
const { today } = await import('../src/services/dashboard.service.js');
const { listDesigns } = await import('../src/services/design.service.js');
const { listProjects } = await import('../src/services/project.service.js');
const { listClientTickets } = await import('../src/services/clientTicket.service.js');
const { billingService } = await import('../src/services/billing.service.js');

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
let server;
let company;
let client;

before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
});
after(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

const design = (fields) => Design.create({ company: company._id, client: client._id, name: fields.name, ...fields, summary: { cost: 100000 } });

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  company = await Company.create({ name: 'Acme Solar' });
  client = await Client.create({ company: company._id, name: 'Ravi' });
});

test('proposal presets list exactly what the dashboard counts', async () => {
  await design({ name: 'Changes', status: 'proposed', clientResponse: { decision: 'changes_requested', respondedAt: new Date() } });
  await design({ name: 'Expiring', status: 'proposed', validUntil: new Date(Date.now() + 2 * DAY) });
  await design({ name: 'Later', status: 'proposed', validUntil: new Date(Date.now() + 30 * DAY) });
  const quiet = await design({ name: 'Quiet', status: 'proposed' });
  await Design.collection.updateOne({ _id: quiet._id }, { $set: { updatedAt: daysAgo(10) } }); // nobody touched it for 10 days
  await design({ name: 'Not started', status: 'won' });
  const started = await design({ name: 'Started', status: 'won', loanRequired: true });
  await Project.create({ company: company._id, design: started._id, client: client._id, steps: [] });
  await Loan.create({ company: company._id, design: started._id, client: client._id, steps: [] });
  await design({ name: 'Needs loan', status: 'won', loanRequired: true });

  const t = await today(company);
  const names = async (show) => (await listDesigns(company, { show })).items.map((d) => d.name).sort();
  assert.deepEqual(await names('changes'), ['Changes']);
  assert.equal(t.proposals.changes, 1);
  assert.deepEqual(await names('no_reply'), ['Quiet']);
  assert.equal(t.proposals.noReply, 1);
  assert.deepEqual(await names('expiring'), ['Expiring']);
  assert.equal(t.expiring.count, 1);
  assert.deepEqual(await names('not_started'), ['Needs loan', 'Not started']);
  assert.equal(t.installations.notStarted, 2);
  assert.deepEqual(await names('loan_missing'), ['Needs loan']);
  assert.equal(t.loans.missing, 1);
  assert.equal((await listDesigns(company, {})).total, 7); // no preset: everything, as before
  assert.equal((await listDesigns(company, { show: 'nonsense' })).total, 7);
});

test('installation presets: jobs with a stuck task, and jobs with a task nobody is on', async () => {
  const agent = await User.create({ email: 'a@x.test', passwordHash: 'x', role: 'agent', name: 'A', company: company._id });
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((name) => design({ name, status: 'won' })));
  await Project.create({ company: company._id, design: a._id, client: client._id, steps: [{ name: 'Wiring', status: 'in_progress', assignee: agent._id, startedAt: daysAgo(9) }] });
  await Project.create({ company: company._id, design: b._id, client: client._id, steps: [{ name: 'Survey', status: 'pending' }] });
  await Project.create({ company: company._id, design: c._id, client: client._id, status: 'completed', steps: [{ name: 'Survey', status: 'pending' }] });

  const t = await today(company);
  const designsOf = async (show) => (await listProjects(company, { show })).items.map((p) => p.design?.name).sort();
  assert.deepEqual(await designsOf('stuck'), ['A']);
  assert.equal(t.installations.stuckCount, 1);
  assert.deepEqual(await designsOf('unassigned'), ['B']); // the completed job is not "in progress"
  assert.equal(t.installations.unassignedSteps, 1);
  assert.equal((await listProjects(company, {})).total, 3);
});

test('installations finished this month, and quotes made this month', async () => {
  const lastMonth = new Date();
  lastMonth.setDate(0); // the last day of the previous month
  const [a, b] = await Promise.all(['Done now', 'Done before'].map((name) => design({ name, status: 'won' })));
  await Project.create({ company: company._id, design: a._id, client: client._id, status: 'completed', installationCompletedAt: new Date(), steps: [] });
  await Project.create({ company: company._id, design: b._id, client: client._id, status: 'completed', installationCompletedAt: lastMonth, steps: [] });
  const old = await design({ name: 'Old quote', status: 'proposed' });
  await Design.collection.updateOne({ _id: old._id }, { $set: { createdAt: lastMonth } });

  const t = await today(company);
  const { activity } = await (await import('../src/services/dashboard.service.js')).dashboard(company);
  assert.deepEqual((await listProjects(company, { show: 'finished_month' })).items.map((p) => p.design?.name), ['Done now']);
  assert.equal(t.installations.finishedThisMonth, 1);
  assert.deepEqual((await listDesigns(company, { show: 'made_month' })).items.map((d) => d.name).sort(), ['Done before', 'Done now']);
  assert.equal(activity.at(-1).created, 2);
});

test('client support: only requests with messages the team has not opened', async () => {
  const owner = await User.create({ email: 'o@x.test', passwordHash: 'x', role: 'company', name: 'Owner', company: company._id });
  const ticket = (subject, teamUnread) => ({ company: company._id, client: client._id, createdBy: owner._id, subject, teamUnread });
  await ClientTicket.create([ticket('Unread', 2), ticket('Read', 0)]);
  const me = { _id: owner._id, role: 'company', company: company._id };
  const unread = await listClientTickets(me, { unread: '1' });
  assert.deepEqual(unread.items.map((x) => x.subject), ['Unread']);
  assert.equal((await today(company)).support.unread, 1);
  assert.equal((await listClientTickets(me, {})).total, 2);
});

test('billing overview carries the last payment date the "unpaid for 60+ days" filter needs', async () => {
  await design({ name: 'Booked', status: 'won' });
  const [row] = await billingService.overview(company);
  assert.equal(row.lastPaidOn, null);
  assert.ok(row.bookedOn instanceof Date);
});

test('leads by status: each count is what the lead list shows for that status', async () => {
  const { leadModels, leadAssignmentModel, leadHandlers } = await import('../src/integrations/leads.js');
  const status = (name, order) => leadModels.status.create({ company: company._id, name, nameKey: name.toLowerCase(), order });
  const [callback, interested] = [await status('Callback', 1), await status('Interested', 2)];
  const { _id: telecaller } = await User.create({ email: 't@x.test', passwordHash: 'x', role: 'agent', name: 'Tara', company: company._id });
  let n = 0;
  const meta = (fields) => leadModels.meta.create({ company: company._id, externalLeadId: `x${(n += 1)}`, pageId: 'p', formId: 'f', fullName: 'M', processingStatus: 'processed', ...fields });
  const converted = await leadModels.status.create({ company: company._id, name: 'Won', nameKey: 'won', order: 3, outcome: 'converted' });
  const m1 = await meta({ adminStatus: interested._id, assignedTo: telecaller }); // the telecaller's Callback wins over the admin's Interested
  await leadAssignmentModel.create({ company: company._id, lead: m1._id, telecaller, isActive: true, currentStatus: callback._id });
  await meta({ adminStatus: interested._id });
  const m3 = await meta({ assignedTo: telecaller }); // assigned, no status yet
  await leadAssignmentModel.create({ company: company._id, lead: m3._id, telecaller, isActive: true, currentStatus: null });
  await meta({}); // never assigned: "Not started" too
  const manual = (fields) => ({ company: company._id, fullName: 'L', phone: '9876543210', ...fields });
  await leadModels.manual.create([manual({ status: callback._id }), manual({}), manual({ status: callback._id, isDeleted: true }), manual({ status: converted._id, assignedTo: telecaller })]);

  const { leads } = await today(company);
  const counts = Object.fromEntries(leads.byStatus.map((s) => [s.name, s.count]));
  assert.deepEqual(counts, { 'Not started': 3, Callback: 2, Interested: 1, Won: 1 });

  // the list endpoint, filtered by each status, returns the same totals
  const listTotal = (statusId) => new Promise((resolve) => {
    leadHandlers.allList({ leadsCompanyId: company._id, query: { statusId } }, { json: (b) => resolve(b.total), status: () => ({ json: (b) => resolve(b) }) });
  });
  for (const s of leads.byStatus) assert.equal(await listTotal(s.id), s.count, s.name);

  // the staff tab: Tara's leads, as the list's "Assigned to" filter shows them
  const { staff } = await today(company);
  const tara = staff.members.find((m) => m.name === 'Tara');
  assert.deepEqual(tara.leads, { assigned: 3, notStarted: 1, converted: 1 });
  const assignedTotal = await new Promise((resolve) => {
    leadHandlers.allList({ leadsCompanyId: company._id, query: { assignedTo: String(telecaller) } }, { json: (b) => resolve(b.total), status: () => ({ json: resolve }) });
  });
  assert.equal(assignedTotal, 3);
});

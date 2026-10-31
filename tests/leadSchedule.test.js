// A lead status can ask for a date (a callback, a site visit…): the status change must carry one, the lead keeps it,
// and the lead lists can be narrowed to what is coming up, due today, or overdue.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const { Company, User } = await import('../src/models/index.js');
const { leadHandlers, leadModels } = await import('../src/integrations/leads.js');

const DAY = 24 * 60 * 60 * 1000;
let server;
let company;
let owner;

before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
});
after(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  company = await Company.create({ name: 'Acme Solar' });
  owner = await User.create({ email: 'o@x.test', passwordHash: 'x', role: 'company', name: 'Owner', company: company._id });
});

/** Run a leads-integration handler as the owner; resolves with { status, body }. */
const call = (handler, { params = {}, query = {}, body = {} } = {}) => new Promise((resolve) => {
  const req = { leadsCompanyId: company._id, user: { _id: owner._id, role: 'company', name: 'Owner' }, params, query, body };
  const res = { status(code) { this.code = code; return this; }, json(payload) { resolve({ status: this.code || 200, body: payload }); } };
  handler(req, res);
});

test('a status that asks for a date refuses a change without one, keeps the date, and the lists filter on it', async () => {
  const callback = await leadModels.status.create({ company: company._id, name: 'Callback', nameKey: 'callback', order: 1, requiresDate: true });
  const interested = await leadModels.status.create({ company: company._id, name: 'Interested', nameKey: 'interested', order: 2 });
  const manual = (fullName) => leadModels.manual.create({ company: company._id, fullName, phone: '9876543210' });
  const [soon, past, plain] = await Promise.all([manual('Soon'), manual('Past'), manual('Plain')]);

  const missing = await call(leadHandlers.manual.updateManualLeadStatus, { params: { id: String(soon._id) }, body: { statusId: String(callback._id) } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.message, /date/i);

  const tomorrow = new Date(Date.now() + DAY);
  const changed = await call(leadHandlers.manual.updateManualLeadStatus, { params: { id: String(soon._id) }, body: { statusId: String(callback._id), scheduledAt: tomorrow.toISOString() } });
  assert.equal(changed.status, 200);
  assert.equal(new Date(changed.body.scheduledAt).getTime(), tomorrow.getTime());
  assert.equal(new Date(changed.body.statusHistory[0].scheduledAt).getTime(), tomorrow.getTime());

  await call(leadHandlers.manual.updateManualLeadStatus, { params: { id: String(past._id) }, body: { statusId: String(callback._id), scheduledAt: new Date(Date.now() - 2 * DAY).toISOString() } });
  const noDate = await call(leadHandlers.manual.updateManualLeadStatus, { params: { id: String(plain._id) }, body: { statusId: String(interested._id) } });
  assert.equal(noDate.status, 200);
  assert.equal(noDate.body.scheduledAt, null); // a status without the flag needs no date

  const names = async (schedule) => (await call(leadHandlers.allList, { query: { schedule } })).body.leads.map((l) => l.fullName);
  assert.deepEqual(await names('upcoming'), ['Soon']);
  assert.deepEqual(await names('overdue'), ['Past']);
  assert.deepEqual((await names('any')).sort(), ['Past', 'Soon']);
  assert.deepEqual(await names('today'), []);
  assert.equal((await names('')).length, 3);

  // the manual list honours it too, and the statuses endpoint tells the form which statuses ask for a date
  const manualList = await call(leadHandlers.manual.listManualLeads, { query: { schedule: 'upcoming' } });
  assert.deepEqual(manualList.body.leads.map((l) => l.fullName), ['Soon']);
  const statuses = await call(leadHandlers.statuses);
  assert.deepEqual(statuses.body.filter((s) => s.requiresDate).map((s) => s.name), ['Callback']);
});

test('moving the date of a lead that already had one is a reschedule: counted, kept, logged, filterable', async () => {
  const callback = await leadModels.status.create({ company: company._id, name: 'Callback', nameKey: 'callback', order: 1, requiresDate: true });
  const lead = await leadModels.manual.create({ company: company._id, fullName: 'Moved', phone: '9876543210' });
  const other = await leadModels.manual.create({ company: company._id, fullName: 'Kept', phone: '9876543211' });
  const base = Date.now();
  const change = (id, days) => call(leadHandlers.manual.updateManualLeadStatus, { params: { id: String(id) }, body: { statusId: String(callback._id), scheduledAt: new Date(base + days * DAY).toISOString() } });

  const first = await change(lead._id, 1);
  assert.equal(first.body.rescheduledCount, 0); // the first date is not a reschedule
  const same = await change(lead._id, 1);
  assert.equal(same.body.rescheduledCount, 0); // the same date again is not one either
  const moved = await change(lead._id, 3);
  assert.equal(moved.body.rescheduledCount, 1);
  assert.equal(moved.body.previousSchedules.length, 1);
  assert.equal(moved.body.previousSchedules[0].statusName, 'Callback');
  assert.equal(moved.body.previousSchedules[0].byName, 'Owner');
  assert.equal(moved.body.statusHistory.at(-1).rescheduled, true);
  assert.equal(moved.body.statusHistory[0].rescheduled, false);
  await change(other._id, 2);

  const rescheduled = await call(leadHandlers.allList, { query: { schedule: 'rescheduled' } });
  assert.deepEqual(rescheduled.body.leads.map((l) => l.fullName), ['Moved']);
  assert.equal(rescheduled.body.leads[0].rescheduledCount, 1);
});

test('handing a lead from one person to another: logged, flagged, and still on the first person’s profile', async () => {
  const { staffOverview } = await import('../src/services/staffOverview.service.js');
  const agent = (name, email) => User.create({ email, passwordHash: 'x', role: 'agent', name, company: company._id });
  const ravi = await agent('Ravi', 'r@x.test');
  const sita = await agent('Sita', 's@x.test');
  const lead = await leadModels.manual.create({ company: company._id, fullName: 'Handed', phone: '9876543210' });
  const other = await leadModels.manual.create({ company: company._id, fullName: 'Kept', phone: '9876543211' });
  const assign = (ids, who) => new Promise((resolve) => {
    const req = { leadsCompanyId: company._id, leadsAssignee: who, user: { _id: owner._id, role: 'company', name: 'Owner' }, body: { leadIds: ids.map(String), counsellorId: who ? String(who._id) : null } };
    leadHandlers.manual.assignManualLeads(req, { status(c) { this.code = c; return this; }, json: (b) => resolve({ status: this?.code || 200, body: b }) });
  });

  await assign([lead._id, other._id], ravi);
  await assign([lead._id], sita);
  await assign([lead._id], sita); // the same person again changes nothing
  const l = await leadModels.manual.findById(lead._id).lean();
  assert.equal(String(l.assignedTo), String(sita._id));
  assert.equal(l.isReassigned, true);
  assert.equal(l.reassignedCount, 1);
  assert.deepEqual(l.assignmentHistory.map((h) => [h.assigneeName, Boolean(h.endedAt)]), [['Ravi', true], ['Sita', false]]);
  assert.deepEqual(l.logs.map((e) => [e.action, e.message, e.byName]), [['lead_assigned', 'Ravi', 'Owner'], ['lead_reassigned', 'Ravi → Sita', 'Owner']]);
  assert.equal((await leadModels.manual.findById(other._id).lean()).isReassigned, false);

  const list = (query) => call(leadHandlers.allList, { query }).then((r) => r.body.leads.map((x) => x.fullName).sort());
  assert.deepEqual(await list({ assignedTo: 'reassigned' }), ['Handed']);
  assert.deepEqual(await list({ assignedTo: String(ravi._id) }), ['Kept']); // what Ravi holds now
  assert.deepEqual(await list({ assignedTo: String(ravi._id), includePast: '1' }), ['Handed', 'Kept']); // and everything Ravi has ever held

  const profile = await staffOverview(company, String(ravi._id));
  assert.equal(profile.leads.total, 1);
  assert.equal(profile.leads.handedOverCount, 1);
  assert.deepEqual(profile.leads.handedOver.map((x) => [x.name, x.nowWith]), [['Handed', 'Sita']]);

  await assign([lead._id], null);
  const gone = await leadModels.manual.findById(lead._id).lean();
  assert.equal(gone.assignedTo, undefined);
  assert.equal(gone.logs.at(-1).action, 'lead_unassigned');
  assert.ok(gone.assignmentHistory.every((h) => h.endedAt));
});

test('a lead assigned before histories existed can still be handed over, and the earlier person is recorded', async () => {
  const agent = (name, email) => User.create({ email, passwordHash: 'x', role: 'agent', name, company: company._id });
  const ravi = await agent('Ravi', 'r@x.test');
  const sita = await agent('Sita', 's@x.test');
  const lead = await leadModels.manual.create({ company: company._id, fullName: 'Old', phone: '9876543210', assignedTo: ravi._id, assignedAt: new Date(Date.now() - DAY) });
  await leadModels.manual.collection.updateOne({ _id: lead._id }, { $unset: { assignmentHistory: 1, logs: 1 } }); // as stored before this feature
  const res = await new Promise((resolve) => {
    const req = { leadsCompanyId: company._id, leadsAssignee: sita, user: { _id: owner._id, role: 'company', name: 'Owner' }, body: { leadIds: [String(lead._id)], counsellorId: String(sita._id) } };
    leadHandlers.manual.assignManualLeads(req, { status(c) { this.code = c; return this; }, json(b) { resolve({ status: this.code || 200, body: b }); } });
  });
  assert.equal(res.status, 200, res.body.message);
  const l = await leadModels.manual.findById(lead._id).lean();
  assert.equal(l.isReassigned, true);
  assert.deepEqual(l.assignmentHistory.map((h) => [h.assigneeName, Boolean(h.endedAt)]), [['Ravi', true], ['Sita', false]]);
  assert.equal(l.logs.at(-1).message, 'Ravi → Sita');
});

test('a status change writes a line in the lead log, as a reschedule when the date moved', async () => {
  const callback = await leadModels.status.create({ company: company._id, name: 'Callback', nameKey: 'callback', order: 1, requiresDate: true });
  const lead = await leadModels.manual.create({ company: company._id, fullName: 'Logged', phone: '9876543210' });
  const base = Date.now();
  const change = (days, remark) => call(leadHandlers.manual.updateManualLeadStatus, { params: { id: String(lead._id) }, body: { statusId: String(callback._id), scheduledAt: new Date(base + days * DAY).toISOString(), remark } });
  await change(1, 'first try');
  const res = await change(4, 'asked for later');
  assert.deepEqual(res.body.logs.map((l) => [l.action, l.byName]), [['lead_status', 'Owner'], ['lead_rescheduled', 'Owner']]);
  assert.match(res.body.logs[0].message, /^Callback · .+ · first try$/);
  assert.match(res.body.logs[1].message, /asked for later$/);
});

test('the board puts every lead in the column of its status, Not started first, and honours the list filters', async () => {
  const callback = await leadModels.status.create({ company: company._id, name: 'Callback', nameKey: 'callback', order: 2 });
  const interested = await leadModels.status.create({ company: company._id, name: 'Interested', nameKey: 'interested', order: 1 });
  const off = await leadModels.status.create({ company: company._id, name: 'Old', nameKey: 'old', order: 3, isActive: false });
  const agent = await User.create({ email: 'a@x.test', passwordHash: 'x', role: 'agent', name: 'Asha', company: company._id });
  const manual = (fullName, extra) => leadModels.manual.create({ company: company._id, fullName, phone: '9876543210', ...extra });
  await manual('Fresh', {});
  await manual('Calling', { status: callback._id, statusName: 'Callback', assignedTo: agent._id });
  await manual('Keen', { status: interested._id, statusName: 'Interested' });
  await manual('Gone', { status: interested._id, statusName: 'Interested', isDeleted: true });
  await leadModels.google.create({ company: company._id, externalLeadId: 'g1', fullName: 'Google keen', status: interested._id, statusName: 'Interested' });

  const { body } = await call(leadHandlers.board, { query: {} });
  assert.deepEqual(body.columns.map((c) => [c.name, c.count]), [['Not started', 1], ['Interested', 2], ['Callback', 1]]); // the switched-off status has no lead, so no column
  assert.equal(body.columns[1].leads.map((l) => l.fullName).sort().join(','), 'Google keen,Keen');
  assert.equal(body.total, 4);
  assert.equal(body.truncated, false);

  const mine = await call(leadHandlers.board, { query: { assignedTo: String(agent._id) } });
  assert.deepEqual(mine.body.columns.map((c) => [c.name, c.count]), [['Not started', 0], ['Interested', 0], ['Callback', 1]]);

  await manual('Stuck in old', { status: off._id, statusName: 'Old' });
  const withOld = await call(leadHandlers.board, { query: { source: 'manual' } });
  assert.deepEqual(withOld.body.columns.at(-1) && [withOld.body.columns.at(-1).name, withOld.body.columns.at(-1).isActive, withOld.body.columns.at(-1).count], ['Old', false, 1]);
});

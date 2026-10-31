// One staff member's page: their steps, leads, AMC visits, expenses and recent activity — only theirs, only this company's.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const { Client, Company, Design, Expense, Project, User } = await import('../src/models/index.js');
const { leadModels } = await import('../src/integrations/leads.js');
const { staffOverview } = await import('../src/services/staffOverview.service.js');

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
let server;
let company;
let client;
let ravi;
let other;

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
  client = await Client.create({ company: company._id, name: 'Sita' });
  const agent = (name, email) => User.create({ email, passwordHash: 'x', role: 'agent', name, company: company._id, phone: '98765', roles: ['Installer'] });
  ravi = await agent('Ravi', 'r@x.test');
  other = await agent('Other', 'o@x.test');
});

test('an unknown or other company’s id is not found', async () => {
  await assert.rejects(staffOverview(company, String(new mongoose.Types.ObjectId())), /not found/i);
  const elsewhere = await Company.create({ name: 'Elsewhere' });
  await assert.rejects(staffOverview(elsewhere, String(ravi._id)), /not found/i);
});

test('their steps, leads, expenses and activity — nobody else’s', async () => {
  const design = await Design.create({ company: company._id, client: client._id, name: 'Sita 5 kWp', status: 'won', summary: { cost: 1 } });
  await Project.create({
    company: company._id,
    design: design._id,
    client: client._id,
    steps: [
      { name: 'Survey', assignee: ravi._id, status: 'done', startedAt: daysAgo(3), completedAt: daysAgo(2) },
      { name: 'Wiring', assignee: ravi._id, status: 'in_progress', priority: 'urgent', startedAt: daysAgo(9) },
      { name: 'Mounting', assignee: ravi._id, status: 'pending', priority: 'low' },
      { name: 'Paperwork', assignee: other._id, status: 'pending' },
    ],
    logs: [{ action: 'step_done', stepName: 'Survey', by: ravi._id, byName: 'Ravi', at: daysAgo(2) }, { action: 'note', by: other._id, at: daysAgo(1) }],
  });
  const project = await Project.findOne({ design: design._id });
  const wiring = project.steps.find((s) => s.name === 'Wiring');
  project.logs.push({ action: 'step_started', step: wiring._id, stepName: 'Wiring', by: other._id, byName: 'Owner', at: daysAgo(1.5) }); // someone else, on Ravi's step
  await project.save();
  const lead = (fields) => ({ company: company._id, fullName: 'Lead', phone: '9876543210', ...fields });
  await leadModels.manual.create([lead({ assignedTo: ravi._id }), lead({ assignedTo: ravi._id }), lead({ assignedTo: other._id }), lead({ assignedTo: ravi._id, isDeleted: true })]);
  await Expense.create([
    { company: company._id, design: design._id, amount: 1200, reason: 'Cable', createdBy: ravi._id, spentOn: daysAgo(5) },
    { company: company._id, design: design._id, amount: 999, reason: 'Bolts', createdBy: other._id },
  ]);

  const o = await staffOverview(company, String(ravi._id));
  assert.equal(o.profile.name, 'Ravi');
  assert.deepEqual(o.profile.roles, ['Installer']);
  assert.equal(o.profile.passwordHash, undefined);
  assert.deepEqual([o.tasks.open, o.tasks.inProgress, o.tasks.pending, o.tasks.stuck, o.tasks.done7, o.tasks.jobs], [2, 1, 1, 1, 1, 1]);
  assert.deepEqual(o.tasks.openList.map((s) => s.step), ['Wiring', 'Mounting']); // urgent first
  assert.equal(o.tasks.avgHours, 24);
  assert.equal(o.tasks.monthly.at(-1).done, 1);
  assert.equal(o.leads.total, 2);
  assert.equal(o.leads.notStarted, 2);
  assert.equal(o.leads.recent.length, 2);
  assert.deepEqual([o.expenses.count, o.expenses.total], [1, 1200]);
  assert.deepEqual(o.activity.map((a) => [a.action, a.byName]), [['step_started', 'Owner'], ['step_done', '']]); // not the unrelated note
  assert.equal(o.visits.open, 0);
});

test('their leads’ log lines appear in the activity feed', async () => {
  const lead = await leadModels.manual.create({ company: company._id, fullName: 'Logged lead', phone: '9876543210', assignedTo: ravi._id, logs: [{ action: 'lead_assigned', message: 'Ravi', byName: 'Owner', at: daysAgo(1) }, { action: 'lead_status', message: 'Callback · Fri', byName: 'Ravi', at: daysAgo(0.5) }] });
  await leadModels.manual.create({ company: company._id, fullName: 'Not theirs', phone: '9876543211', assignedTo: other._id, logs: [{ action: 'lead_assigned', message: 'Other', byName: 'Owner' }] });
  const o = await staffOverview(company, String(ravi._id));
  assert.deepEqual(o.leads.log.map((e) => [e.action, e.where]), [['lead_status', 'Logged lead'], ['lead_assigned', 'Logged lead']]);
  assert.deepEqual(o.activity.filter((a) => a.phase === 'lead').map((a) => a.action), ['lead_status', 'lead_assigned']);
  assert.equal(String(lead._id).length, 24);
});

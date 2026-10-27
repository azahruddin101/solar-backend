// The staff sidebar's numbers: only the areas the staff member may view, counted as their lists show them — their own
// leads unless they may view all, their own open tasks and AMC visits.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { normalizePermissions } from '../src/constants/permissions.js';

const { Client, Company, Loan, Project, Supplier, Ticket } = await import('../src/models/index.js');
const { leadModels } = await import('../src/integrations/leads.js');
const { staffCounts } = await import('../src/services/dashboard.service.js');

let server;
let company;
const me = new mongoose.Types.ObjectId();
const someoneElse = new mongoose.Types.ObjectId();
const staff = (...permissions) => ({ _id: me, role: 'agent', company: company._id, effectivePermissions: normalizePermissions(permissions) });

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
  const client = await Client.create({ company: company._id, name: 'Ravi' });
  await Client.create({ company: company._id, name: 'Sita' });
  const lead = (assignedTo) => ({ company: company._id, fullName: 'Lead', phone: '9876543210', assignedTo });
  await leadModels.manual.create([lead(me), lead(me), lead(someoneElse), lead(null)]);
  const design = new mongoose.Types.ObjectId();
  await Loan.create({ company: company._id, design, client: client._id, steps: [] });
  await Project.create({
    company: company._id,
    design,
    client: client._id,
    status: 'active',
    steps: [{ name: 'Survey', assignee: me, status: 'done' }, { name: 'Wiring', assignee: me, status: 'pending' }],
    amcVisits: [
      { name: 'AMC1', assignee: me, workflowStatus: 'assigned' },
      { name: 'AMC2', assignee: me, workflowStatus: 'completed', status: 'completed' },
      { name: 'AMC3', assignee: someoneElse, workflowStatus: 'assigned' },
    ],
  });
});

test('only the areas they may view are counted; their own tasks and visits always are', async () => {
  const counts = await staffCounts(staff('clients:view', 'loans:view', 'expenses:view'), company);
  assert.deepEqual(Object.keys(counts).sort(), ['amc', 'clients', 'expenses', 'loans', 'myTasks']);
  assert.equal(counts.expenses, 0); // no booked proposal, expense or budget yet
  assert.equal(counts.clients, 2);
  assert.equal(counts.loans, 1);
  assert.equal(counts.myTasks, 1); // one installation with a step of theirs to do
  assert.equal(counts.amc, 1); // AMC1: open and theirs
  assert.deepEqual(Object.keys(await staffCounts(staff(), company)).sort(), ['amc', 'myTasks']);
});

test('suppliers are counted for staff who see Inventory (where the Suppliers page is)', async () => {
  await Supplier.create([{ company: company._id, name: 'Sunrise' }, { company: company._id, name: 'Deccan' }]);
  assert.equal((await staffCounts(staff('inventory:view'), company)).suppliers, 2);
  assert.equal((await staffCounts(staff('finances:view'), company)).suppliers, undefined);
});

test('platform support: the company’s open and in-progress tickets, for staff who may view them', async () => {
  const ticket = (status, companyId = company._id) => ({ company: companyId, subject: 'Help', category: 'technical', status, createdBy: me, ref: `TKT-${Math.random().toString(36).slice(2, 8)}` });
  await Ticket.collection.insertMany([ticket('open'), ticket('in_progress'), ticket('resolved'), ticket('closed'), ticket('open', new mongoose.Types.ObjectId())]);
  assert.equal((await staffCounts(staff('support:view'), company)).support, 2);
  assert.equal((await staffCounts(staff('clients:view'), company)).support, undefined);
});

test('leads: their own unless they may view all', async () => {
  const own = await staffCounts(staff('leads:view'), company);
  assert.equal(own.manualLeads, 2);
  assert.equal(own.leads, 2);
  const all = await staffCounts(staff('leads:view_all'), company);
  assert.equal(all.manualLeads, 4);
  assert.equal(all.leads, 4);
});

// A client's page shows everything about them: proposals, installations with steps, money, loans, AMC visits and
// support requests — scoped to this client, and only the areas the person asking may see.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client, ClientTicket, Company, Design, Expense, Invoice, Loan, Payment, Project, User } from '../src/models/index.js';
import { clientOverview } from '../src/services/clientOverview.service.js';

let server;
let company;
let owner;
let sita;
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
  company = await Company.create({ name: 'Acme Solar', amcTemplates: [{ name: 'AMC1', kind: 'mandatory', price: 0, daysAfterInstallation: 60 }] });
  owner = await User.create({ email: 'o@x.test', passwordHash: 'x', role: 'company', name: 'Owner', company: company._id });
  sita = await Client.create({ company: company._id, name: 'Sita' });
  other = await Client.create({ company: company._id, name: 'Other' });
});

test('every block is scoped to the client', async () => {
  const ravi = await User.create({ email: 'r@x.test', passwordHash: 'x', role: 'agent', name: 'Ravi', company: company._id });
  const d1 = await Design.create({ company: company._id, client: sita._id, name: 'Sita roof', status: 'won', loanRequired: true, summary: { cost: 100000, kwp: 5 } });
  const d2 = await Design.create({ company: company._id, client: sita._id, name: 'Sita shed', status: 'proposed', summary: { cost: 50000 } });
  const dx = await Design.create({ company: company._id, client: other._id, name: 'Other roof', status: 'won', summary: { cost: 70000 } });
  await Project.create({ company: company._id, design: d1._id, client: sita._id, status: 'completed', installationCompletedAt: new Date(), steps: [{ name: 'Survey', status: 'done' }, { name: 'Wiring', status: 'done', assignee: ravi._id }] });
  await Project.create({ company: company._id, design: dx._id, client: other._id, steps: [{ name: 'Survey', status: 'pending' }] });
  await Payment.create([{ company: company._id, design: d1._id, amount: 40000, receiptNo: 'R1' }, { company: company._id, design: dx._id, amount: 1000, receiptNo: 'R2' }]);
  await Invoice.create({ company: company._id, design: d1._id, invoiceNo: 'INV-1', total: 100000 });
  await Loan.create({ company: company._id, design: d1._id, client: sita._id, lender: 'SBI', amount: 60000, steps: [{ name: 'Apply', status: 'done' }, { name: 'Sanction', status: 'pending' }] });
  await Expense.create({ company: company._id, design: d1._id, amount: 1200, reason: 'Cable', createdBy: owner._id });
  await ClientTicket.create({ company: company._id, client: sita._id, createdBy: owner._id, subject: 'Inverter beeping' });

  const o = await clientOverview(company, owner, String(sita._id));
  assert.equal(o.client.name, 'Sita');
  assert.deepEqual(o.proposals.map((p) => [p.name, p.status, p.value]).sort(), [['Sita roof', 'won', 100000], ['Sita shed', 'proposed', 50000]]);
  assert.deepEqual(o.installations.map((p) => [p.design.name, p.status, p.done, p.total]), [['Sita roof', 'completed', 2, 2]]);
  assert.equal(o.installations[0].steps[1].assignee.name, 'Ravi');
  assert.deepEqual([o.billing.total, o.billing.paid, o.billing.balance], [100000, 40000, 60000]);
  assert.deepEqual(o.billing.invoices.map((i) => i.invoiceNo), ['INV-1']);
  assert.deepEqual(o.loans.map((l) => [l.lender, l.done, l.total, l.currentStep]), [['SBI', 1, 2, 'Sanction']]);
  assert.deepEqual(o.amc.map((v) => [v.name, v.status]), [['AMC1', 'pending']]); // scheduled from the completed installation
  assert.deepEqual(o.tickets.map((t) => t.subject), ['Inverter beeping']);
  assert.equal(o.expenses.total, 1200);
  assert.equal(d2.name, 'Sita shed');
});

test('a staff member only gets the areas they may view; another company’s client is not found', async () => {
  const agent = await User.create({ email: 'a@x.test', passwordHash: 'x', role: 'agent', name: 'Asha', company: company._id, permissions: ['clients:view', 'tasks:view'] });
  await Design.create({ company: company._id, client: sita._id, name: 'Sita roof', status: 'won', summary: { cost: 1 } });
  const o = await clientOverview(company, agent, String(sita._id));
  assert.equal(o.proposals.length, 1);
  assert.ok(Array.isArray(o.installations) && Array.isArray(o.amc));
  assert.equal(o.billing, null);
  assert.equal(o.loans, null);
  assert.equal(o.tickets, null);
  const elsewhere = await Company.create({ name: 'Elsewhere' });
  await assert.rejects(clientOverview(elsewhere, owner, String(sita._id)), /not found/i);
});

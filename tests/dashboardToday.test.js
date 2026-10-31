// The owner's first screen (/api/dashboard/today): today's to-do counts, spending, quotes about to expire,
// installations by step, loans not started, low stock and where leads come from — each counted from existing records.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const { Batch, Client, Company, Design, Expense, Loan, Payment, Product, Project, SerialUnit, User } = await import('../src/models/index.js');
const { leadModels } = await import('../src/integrations/leads.js');
const { counts, dashboard, today } = await import('../src/services/dashboard.service.js');
const { Bill, EwayBill } = await import('../src/models/index.js');

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

const design = (fields) => Design.create({ company: company._id, client: client._id, name: 'Proposal', ...fields, summary: { cost: 100000, kwp: 5, annualKwh: 7000, ...fields?.summary } });
const pay = (d, amount, receivedOn) => Payment.create({ company: company._id, client: client._id, design: d._id, receiptNo: `R-${Math.random()}`, amount, receivedOn });

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  company = await Company.create({ name: 'Acme Solar' });
  client = await Client.create({ company: company._id, name: 'Ravi' });
});

test('an empty company gets zeros, not errors', async () => {
  const t = await today(company);
  assert.equal(t.amc.dueToday, 0);
  assert.equal(t.money.spentThisMonth, 0);
  assert.equal(t.installations.avgDaysToFinish, null);
  assert.equal(t.leads.funnel.leads, 0);
});

test('there is no list of who owes money: bills are paid when made, so the dashboard only shows what is yet to bill', async () => {
  const fresh = await design({ name: 'Fresh', status: 'won' });
  const over = await design({ name: 'Over', status: 'won' });
  const paidUp = await design({ name: 'Paid', status: 'won' });
  await pay(fresh, 40000, daysAgo(5)); // 100000 quoted, 40000 billed: 60000 yet to bill
  await pay(over, 130000, daysAgo(2)); // billed 30000 above the quote: nothing to bill, and not netted off the others
  await pay(paidUp, 100000, daysAgo(2));
  await Expense.create({ company: company._id, design: fresh._id, amount: 2500, reason: 'Cable', spentOn: new Date() });

  const { money } = await today(company);
  assert.deepEqual(Object.keys(money), ['spentThisMonth']);
  assert.equal(money.spentThisMonth, 2500);
  const d = await dashboard(company);
  assert.equal(d.attention.collect, undefined);
  assert.deepEqual(d.money, { quoted: 300000, billed: 270000, yetToBill: 60000, billedPct: 90 });
});

test('the billing count in the sidebar is the chain waiting on someone: open e-way bills and bills with no invoice', async () => {
  const d = await design({ status: 'won' });
  const base = { company: company._id, client: client._id, design: d._id, title: 'x', total: 100 };
  await EwayBill.create([{ ...base, ewayNo: 'EWB-1', status: 'open' }, { ...base, ewayNo: 'EWB-2', status: 'billed' }, { ...base, ewayNo: 'EWB-3', status: 'cancelled' }]);
  await Bill.create([{ ...base, billNo: 'BILL-1', status: 'paid' }, { ...base, billNo: 'BILL-2', status: 'invoiced' }]);
  assert.equal((await counts(company)).billing, 2); // EWB-1 and BILL-1
});

test('month-by-month series: expenses, finished installations, payment modes and leads per source', async () => {
  const d = await design({ status: 'won' });
  await Expense.create({ company: company._id, design: d._id, amount: 1500, reason: 'Cable', spentOn: new Date() });
  await Project.create({ company: company._id, design: d._id, client: client._id, status: 'completed', installationCompletedAt: new Date(), steps: [] });
  await Payment.create([
    { company: company._id, client: client._id, design: d._id, receiptNo: 'R-1', amount: 3000, mode: 'upi', receivedOn: new Date() },
    { company: company._id, client: client._id, design: d._id, receiptNo: 'R-2', amount: 1000, mode: 'cash', receivedOn: new Date() },
  ]);
  await leadModels.manual.create({ company: company._id, fullName: 'Lead', phone: '9876543210' });

  const t = await today(company);
  assert.equal(t.monthly.length, 12);
  const now = t.monthly.at(-1);
  assert.deepEqual([now.spent, now.finished, now.leads.manual, now.leads.meta], [1500, 1, 1, 0]);
  assert.equal(t.monthly[0].leads, undefined); // leads only for the last 6 months
  assert.deepEqual(t.paymentModes, [{ mode: 'upi', amount: 3000 }, { mode: 'cash', amount: 1000 }]);
});

test('quotes expiring in the next 7 days; already-expired ones are only counted', async () => {
  await design({ name: 'Today', status: 'proposed', validUntil: new Date() });
  await design({ name: 'Soon', status: 'proposed', validUntil: new Date(Date.now() + 3 * DAY) });
  await design({ name: 'Later', status: 'proposed', validUntil: new Date(Date.now() + 20 * DAY) });
  await design({ name: 'Gone', status: 'proposed', validUntil: daysAgo(3) });
  await design({ name: 'Booked', status: 'won', validUntil: new Date() });
  await design({ name: 'Changes', status: 'proposed', clientResponse: { decision: 'changes_requested', respondedAt: new Date() } });

  const { expiring, proposals } = await today(company);
  assert.deepEqual(expiring.items.map((e) => [e.name, e.daysLeft]), [['Today', 0], ['Soon', 3]]);
  assert.equal(expiring.expired, 1);
  assert.equal(proposals.changes, 1);
  assert.equal(proposals.noReply, 0); // all just created
  assert.equal(proposals.noInvoice, 1); // 'Booked' has a price and no invoice
});

test('installations by current step, unassigned and stuck steps, and booked jobs not started', async () => {
  const a = await design({ name: 'A', status: 'won' });
  const b = await design({ name: 'B', status: 'won' });
  await design({ name: 'Waiting', status: 'won' });
  const { _id: agent } = await User.create({ email: 'ravi@x.test', passwordHash: 'x', role: 'agent', name: 'Ravi K', company: company._id });
  await Project.create({ company: company._id, design: a._id, client: client._id, steps: [{ name: 'Survey', status: 'done', assignee: agent }, { name: 'Wiring', status: 'in_progress', assignee: agent, startedAt: daysAgo(10) }] });
  await Project.create({ company: company._id, design: b._id, client: client._id, steps: [{ name: 'Survey', status: 'pending' }, { name: 'Wiring', status: 'pending' }] });

  const { installations } = await today(company);
  assert.equal(installations.active, 2);
  assert.deepEqual(installations.byStep, [{ step: 'Survey', count: 1 }, { step: 'Wiring', count: 1 }]);
  assert.equal(installations.unassignedSteps, 2);
  assert.deepEqual(installations.stuck.map((s) => [s.step, s.assignee, s.days]), [['Wiring', 'Ravi K', 10]]);
  assert.equal(installations.notStarted, 1);
});

test('loans needed with no loan file, and products at or below their reorder level', async () => {
  const onLoan = await design({ name: 'On loan', status: 'won', loanRequired: true });
  const filed = await design({ name: 'Filed', status: 'won', loanRequired: true });
  await Loan.create({ company: company._id, design: filed._id, client: client._id, amount: 200000, steps: [] });
  const category = new mongoose.Types.ObjectId();
  const [low, fine] = await Product.create([{ company: company._id, category, name: 'Panel', reorderLevel: 20 }, { company: company._id, category, name: 'Cable', reorderLevel: 5 }]);
  await Product.create({ company: company._id, category, name: 'No level set' });
  const batch = (product, qty) => ({ company: company._id, product, supplier: new mongoose.Types.ObjectId(), qtyReceived: qty, qtyRemaining: qty, basePrice: 1, wholesalePrice: 1, retailPrice: 1 });
  await Batch.create([batch(low._id, 12), batch(fine._id, 50)]);

  const t = await today(company);
  assert.deepEqual(t.loans.missingItems.map((d) => d.name), [onLoan.name]);
  assert.equal(t.loans.open, 1);
  assert.equal(t.loans.openAmount, 200000);
  assert.deepEqual(t.stock.items.map((p) => [p.name, p.stock]), [['No level set', 0], ['Panel', 12]]); // out of stock first, then low
  assert.equal(t.stock.products, 3);
  assert.equal(t.stock.value, 62); // 12 + 50 left, at the base price of 1
  assert.equal(t.stock.outOfStock, 1); // 'No level set' has none: "Out of stock", as the catalog shows it
  assert.equal(t.stock.low, 1); // 'Panel': 12 left, reorder at 20
  assert.equal(t.monthly.at(-1).stockReceived, 62);
});

test('leads: unassigned, contacted and converted per source', async () => {
  const status = new mongoose.Types.ObjectId();
  const lead = (fields) => ({ company: company._id, fullName: 'Lead', phone: '9876543210', ...fields });
  await leadModels.manual.create([lead({}), lead({ assignedTo: new mongoose.Types.ObjectId(), status }), lead({ status, convertedClient: client._id }), lead({ isDeleted: true })]);

  const { leads } = await today(company);
  const manual = leads.sources.find((s) => s.key === 'manual');
  assert.deepEqual([manual.unassigned, manual.total, manual.contacted, manual.converted], [2, 3, 2, 1]);
  assert.deepEqual(leads.funnel, { leads: 3, contacted: 2, converted: 1 });
  assert.equal(leads.unassigned, 2);
});

test('warranties ending in the next 60 days, on installed units only', async () => {
  const category = new mongoose.Types.ObjectId();
  const inverter = await Product.create({ company: company._id, category, name: 'Inverter', warrantyMonths: 12, isSerialized: true });
  const installedOn = new Date();
  installedOn.setMonth(installedOn.getMonth() - 12);
  installedOn.setDate(installedOn.getDate() + 20); // warranty ends in about 20 days
  const unit = (serialNo, fields) => ({ company: company._id, product: inverter._id, batch: new mongoose.Types.ObjectId(), serialNo, ...fields });
  await SerialUnit.create([
    unit('S-1', { status: 'installed', installDate: installedOn }),
    unit('S-2', { status: 'installed', installDate: new Date() }), // a whole year left
    unit('S-3', { status: 'inStock' }),
  ]);

  const { stock } = await today(company);
  assert.deepEqual(stock.warranties.map((w) => [w.serialNo, w.product]), [['S-1', 'Inverter']]);
  assert.ok(stock.warranties[0].daysLeft >= 18 && stock.warranties[0].daysLeft <= 22);
});

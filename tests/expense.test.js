// Expenses per proposal, against an in-memory MongoDB.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client, Company, Design, Expense, ProjectBudget } from '../src/models/index.js';
import { deleteDesign } from '../src/services/design.service.js';
import * as expenses from '../src/services/expense.service.js';

let server;
let company;
let won;
let draft;
const staff = { _id: new mongoose.Types.ObjectId(), name: 'Farah', role: 'agent' };

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
  const client = await Client.create({ company: company._id, name: 'Sunil Patil' });
  won = await Design.create({ company: company._id, client: client._id, name: 'Patil bungalow', status: 'won' });
  draft = await Design.create({ company: company._id, client: client._id, name: 'Still a draft', status: 'draft' });
});

test('expenses add up per proposal, with who entered them', async () => {
  await expenses.create(company, staff, won.id, { amount: 1200.5, reason: 'Transport of panels' });
  await expenses.create(company, staff, won.id, { amount: 300, reason: 'Labour', spentOn: '2026-10-01', note: '  Two helpers, half day ' });
  const res = await expenses.listForDesign(company, won.id);
  assert.deepEqual(res.items.map((e) => e.note), ['', 'Two helpers, half day']); // optional, trimmed
  assert.equal(res.total, 1500.5);
  assert.equal(res.items.length, 2);
  assert.equal(res.items[0].createdByName, 'Farah');
  assert.equal(res.design.client.name, 'Sunil Patil');
});

test('the overview lists booked proposals and any proposal that has expenses', async () => {
  let ov = await expenses.overview(company);
  assert.deepEqual(ov.items.map((i) => i.name), ['Patil bungalow']);
  await expenses.create(company, staff, draft.id, { amount: 50, reason: 'Site visit fuel' });
  ov = await expenses.overview(company);
  assert.equal(ov.items.length, 2);
  assert.equal(ov.totalSpent, 50);
  assert.equal((await expenses.overview(company, { q: 'bungalow' })).items.length, 1);
  assert.equal(await expenses.projectCount(company), ov.items.length); // the sidebar count is the list's length
});

test('edit, delete, other companies and deleting the proposal', async () => {
  const e = await expenses.create(company, staff, won.id, { amount: 100, reason: 'Cable' });
  assert.equal((await expenses.update(company, e.id, { amount: 120 })).amount, 120);
  assert.equal((await expenses.update(company, e.id, { note: 'Bill 4521' })).note, 'Bill 4521');
  assert.equal((await expenses.update(company, e.id, { amount: 130 })).note, 'Bill 4521'); // untouched when not sent
  const other = await Company.create({ name: 'Other' });
  await assert.rejects(expenses.update(other, e.id, { amount: 1 }), /not found/i);
  await assert.rejects(expenses.listForDesign(other, won.id), /not found/i);
  await expenses.remove(company, e.id);
  assert.equal(await Expense.countDocuments(), 0);
  await expenses.create(company, staff, won.id, { amount: 10, reason: 'Nuts' });
  await deleteDesign(company, won.id);
  assert.equal(await Expense.countDocuments(), 0);
});

test('a budget per project: set, change, usage and removal', async () => {
  await expenses.create(company, staff, won.id, { amount: 600, reason: 'Labour' });
  assert.deepEqual((await expenses.setBudget(company, staff, won.id, { amount: 1000, note: 'Site estimate' })).amount, 1000);
  let res = await expenses.listForDesign(company, won.id);
  assert.equal(res.budget.note, 'Site estimate');
  assert.equal(res.budget.updatedByName, 'Farah');
  assert.equal(res.budgetUsed, 60);
  await expenses.setBudget(company, staff, won.id, { amount: 500 });
  assert.equal(await ProjectBudget.countDocuments(), 1);
  assert.equal((await expenses.listForDesign(company, won.id)).budgetUsed, 120);
  const ov = await expenses.overview(company);
  assert.equal(ov.totalBudget, 500);
  // a budget alone is enough to list a draft
  await expenses.setBudget(company, staff, draft.id, { amount: 50 });
  assert.equal((await expenses.overview(company)).items.length, 2);
  await expenses.removeBudget(company, won.id);
  res = await expenses.listForDesign(company, won.id);
  assert.equal(res.budget, null);
  assert.equal(res.budgetUsed, null);
  await assert.rejects(expenses.setBudget(await Company.create({ name: 'Other' }), staff, draft.id, { amount: 1 }), /not found/i);
  await deleteDesign(company, draft.id);
  assert.equal(await ProjectBudget.countDocuments(), 0);
});

test('profit & loss is budget minus expenses', async () => {
  await expenses.create(company, staff, won.id, { amount: 60000, reason: 'Material purchase' });
  await expenses.create(company, staff, won.id, { amount: 5000, reason: 'Labour charges' });
  await expenses.create(company, staff, draft.id, { amount: 1000, reason: 'Travel & site visit' });
  await expenses.setBudget(company, staff, won.id, { amount: 100000 });
  await expenses.setBudget(company, staff, draft.id, { amount: 800 });

  assert.equal((await expenses.listForDesign(company, won.id)).profit, 35000);
  const res = await expenses.analytics(company);
  const p = res.projects.find((x) => x.id === won.id);
  assert.equal(p.profit, 35000);
  assert.equal(p.budgetUsed, 65);
  const d = res.projects.find((x) => x.id === draft.id);
  assert.equal(d.profit, -200); // over its budget: a loss
  assert.equal(res.totals.budget, 100800);
  assert.equal(res.totals.spent, 66000);
  assert.equal(res.totals.profit, 34800);
  assert.equal(res.totals.overBudget, 1);
  assert.equal(res.monthly.length, 12);
  assert.equal(res.monthly.at(-1).spent, 66000);
  assert.deepEqual(res.byReason.map((r) => r.reason), ['Material purchase', 'Labour charges', 'Travel & site visit']);
  assert.equal((await expenses.analytics(company, { months: 6 })).monthly.length, 6);

  // without a budget there is no profit or loss to show
  await expenses.removeBudget(company, won.id);
  assert.equal((await expenses.listForDesign(company, won.id)).profit, null);
  const after = await expenses.analytics(company);
  assert.equal(after.totals.spent, 66000);
  assert.equal(after.totals.profit, -200);
});

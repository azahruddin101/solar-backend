// Loans against an in-memory MongoDB: opened from a proposal's Loan option, moved through the company's steps, and
// shown to the client (for their own shared proposals) without the company's private notes.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client, Company, Design, Loan } from '../src/models/index.js';
import { migrateLoans } from '../src/migrations/loan.migration.js';
import { createDesign, deleteDesign, updateDesign } from '../src/services/design.service.js';
import { getLoanOfDesign, listLoans, listMyLoans, syncLoanSteps, updateLoan, updateLoanStep, updateLoanSteps } from '../src/services/loan.service.js';

let server;
let company;
let ravi;
const owner = { _id: new mongoose.Types.ObjectId(), name: 'Owner', role: 'company' };
const clientUser = (client) => ({ company: company._id, client: client._id });
const proposal = (fields = {}) => createDesign(company, owner, { client: ravi.id, type: 'quick', ...fields });

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
  await Loan.syncIndexes();
  company = await Company.create({ name: 'Acme Solar' });
  await updateLoanSteps(company, { steps: [{ name: 'Documents' }, { name: 'Sanction', description: 'Bank sanctions the loan' }] });
  ravi = await Client.create({ company: company._id, name: 'Ravi Kumar' });
});

test('a proposal created with the loan option gets a loan with the template steps', async () => {
  const onLoan = await proposal({ name: 'Rooftop 5 kW', loanRequired: true });
  await proposal({ name: 'Cash option' });
  const loans = await listLoans(company);
  assert.equal(loans.length, 1);
  assert.equal(loans[0].design.name, 'Rooftop 5 kW');
  assert.equal(loans[0].client.name, 'Ravi Kumar');
  assert.deepEqual(loans[0].steps.map((s) => [s.name, s.status]), [['Documents', 'pending'], ['Sanction', 'pending']]);
  assert.equal((await getLoanOfDesign(company, onLoan.id)).id, loans[0].id);
});

test('one client can have a loan on each of several proposals', async () => {
  await proposal({ name: 'Option A', loanRequired: true });
  await proposal({ name: 'Option B', loanRequired: true });
  assert.equal((await listLoans(company)).length, 2);
});

test('turning the option on later opens the loan; off removes it only while untouched', async () => {
  const d = await proposal();
  await updateDesign(company, owner, d.id, { loanRequired: true });
  assert.equal(await Loan.countDocuments(), 1);
  await updateDesign(company, owner, d.id, { loanRequired: false });
  assert.equal(await Loan.countDocuments(), 0);

  await updateDesign(company, owner, d.id, { loanRequired: true });
  const [loan] = await listLoans(company);
  await updateLoanStep(company, owner, loan.id, loan.steps[0].id, { status: 'done' });
  await assert.rejects(updateDesign(company, owner, d.id, { loanRequired: false }), /already being processed/);
  assert.equal(await Loan.countDocuments(), 1);
  assert.equal((await Design.findById(d.id)).loanRequired, true);
});

test('finishing every step completes the loan; reopening a step reopens it', async () => {
  await proposal({ loanRequired: true });
  const [loan] = await listLoans(company);
  await updateLoanStep(company, owner, loan.id, loan.steps[0].id, { status: 'done' });
  let next = await updateLoanStep(company, owner, loan.id, loan.steps[1].id, { status: 'done', remark: 'Sanctioned by SBI' });
  assert.equal(next.status, 'completed');
  assert.equal(next.steps[1].remark, 'Sanctioned by SBI');
  next = await updateLoanStep(company, owner, loan.id, loan.steps[1].id, { status: 'in_progress' });
  assert.equal(next.status, 'in_progress');
  assert.equal(next.steps[1].completedAt, null);
});

test('steps added to the template later can be pulled into an open loan', async () => {
  await proposal({ loanRequired: true });
  const [loan] = await listLoans(company);
  await assert.rejects(syncLoanSteps(company, owner, loan.id), /already has every step/);
  await updateLoanSteps(company, { steps: [{ name: 'Documents' }, { name: 'Sanction' }, { name: 'Disbursement' }] });
  const next = await syncLoanSteps(company, owner, loan.id);
  assert.deepEqual(next.steps.map((s) => s.name), ['Documents', 'Sanction', 'Disbursement']);
});

test('the client sees the loans of their own proposals only, drafts included, without private notes', async () => {
  const asha = await Client.create({ company: company._id, name: 'Asha Rao' });
  const shared = await proposal({ name: 'Rooftop 5 kW', loanRequired: true });
  await updateDesign(company, owner, shared.id, { status: 'proposed' });
  await proposal({ name: 'Still a draft', loanRequired: true });
  await createDesign(company, owner, { client: asha.id, type: 'quick', loanRequired: true });
  const loan = await getLoanOfDesign(company, shared.id);
  await updateLoan(company, owner, loan.id, { lender: 'SBI', amount: 250000, notes: 'CIBIL 640 — follow up' });

  const mine = await listMyLoans(clientUser(ravi));
  assert.deepEqual(mine.map((l) => [l.proposal.name, l.proposal.shared]).sort(), [['Rooftop 5 kW', true], ['Still a draft', false]]);
  const sharedLoan = mine.find((l) => l.proposal.shared);
  assert.equal(sharedLoan.lender, 'SBI');
  assert.equal(sharedLoan.notes, undefined);
  assert.equal(sharedLoan.logs, undefined);
  const hers = await listMyLoans(clientUser(asha));
  assert.equal(hers.length, 1);
  assert.equal(hers[0].lender, ''); // never Ravi's
});

test('the loan follows the proposal to another client, and goes when it is deleted', async () => {
  const asha = await Client.create({ company: company._id, name: 'Asha Rao' });
  const d = await proposal({ loanRequired: true });
  await updateDesign(company, owner, d.id, { client: asha.id });
  assert.equal(String((await Loan.findOne()).client), asha.id);
  await deleteDesign(company, d.id);
  assert.equal(await Loan.countDocuments(), 0);
});

test('migration opens loans for proposals already marked Loan', async () => {
  const d = await Design.create({ company: company._id, client: ravi._id, name: 'Old proposal', loanRequired: true });
  await migrateLoans();
  await migrateLoans(); // safe to run again
  const loans = await Loan.find({ design: d._id });
  assert.equal(loans.length, 1);
  assert.equal(loans[0].steps.length, 2);
});

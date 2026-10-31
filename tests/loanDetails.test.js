// A loan's details: bank, branch, IFSC, reference, amount, rate, period, EMI, down payment, fee and dates all save
// and clear; the IFSC is kept upper-case; bad dates are dropped.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client, Company, Design, Loan, User } from '../src/models/index.js';
import { updateLoan } from '../src/services/loan.service.js';

let server;
let company;
let owner;
let loan;

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
  const client = await Client.create({ company: company._id, name: 'Sita' });
  const design = await Design.create({ company: company._id, client: client._id, name: 'Sita roof', status: 'won', loanRequired: true });
  loan = await Loan.create({ company: company._id, design: design._id, client: client._id, steps: [] });
});

test('every loan detail saves, and clears again', async () => {
  const saved = await updateLoan(company, owner, loan.id, {
    lender: 'SBI', branch: 'Nigdi', ifsc: 'sbin0001234', accountRef: 'APP-77',
    amount: 250000, interestRate: 9.5, tenureMonths: 60, emi: 5250, downPayment: 50000, processingFee: 2500,
    sanctionedOn: '2026-10-20', disbursedOn: 'not a date',
  });
  assert.equal(saved.ifsc, 'SBIN0001234');
  assert.deepEqual([saved.branch, saved.accountRef, saved.amount, saved.interestRate, saved.tenureMonths, saved.emi, saved.downPayment, saved.processingFee], ['Nigdi', 'APP-77', 250000, 9.5, 60, 5250, 50000, 2500]);
  assert.equal(new Date(saved.sanctionedOn).toISOString().slice(0, 10), '2026-10-20');
  assert.equal(saved.disbursedOn, null);

  const cleared = await updateLoan(company, owner, loan.id, { emi: null, sanctionedOn: null, branch: '' });
  assert.equal(cleared.emi, null);
  assert.equal(cleared.sanctionedOn, null);
  assert.equal(cleared.branch, '');
  assert.equal(cleared.amount, 250000); // untouched fields stay
});

test('the EMI is worked out from the amount, rate and period when none is given, and a given one is kept', async () => {
  const { monthlyEmi } = await import('../src/utils/emi.js');
  assert.equal(monthlyEmi(250000, 9.5, 60), 5250); // reducing balance
  assert.equal(monthlyEmi(120000, 0, 12), 10000); // no interest: amount over months
  assert.equal(monthlyEmi(0, 9.5, 60), 0);
  assert.equal(monthlyEmi(250000, 9.5, 0), 0);

  const auto = await updateLoan(company, owner, loan.id, { amount: 250000, interestRate: 9.5, tenureMonths: 60 });
  assert.equal(auto.emi, 5250);
  const kept = await updateLoan(company, owner, loan.id, { amount: 300000 }); // an EMI already stored is not overwritten
  assert.equal(kept.emi, 5250);
  const typed = await updateLoan(company, owner, loan.id, { amount: 300000, emi: 6000 }); // one the bank quoted is kept as typed
  assert.equal(typed.emi, 6000);
});

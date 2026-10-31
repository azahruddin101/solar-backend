// A subsidy's details: bank, branch, IFSC, reference, amount, rate, period, EMI, down payment, fee and dates all save
// and clear; the IFSC is kept upper-case; bad dates are dropped.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client, Company, Design, Subsidy, User } from '../src/models/index.js';
import { updateSubsidy } from '../src/services/subsidy.service.js';

let server;
let company;
let owner;
let subsidy;

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
  const design = await Design.create({ company: company._id, client: client._id, name: 'Sita roof', status: 'won', subsidy: { enabled: true, central: 78000, state: 0 } });
  subsidy = await Subsidy.create({ company: company._id, design: design._id, client: client._id, steps: [] });
});

test('every subsidy detail saves, and clears again', async () => {
  const saved = await updateSubsidy(company, owner, subsidy.id, {
    scheme: 'PM Surya Ghar', applicationNo: 'PMSG-77', consumerNo: '170012345678', discom: 'MSEDCL',
    centralAmount: 78000, stateAmount: 15000, receivedAmount: 30000,
    approvedOn: '2026-10-20', creditedOn: 'not a date',
  });
  assert.deepEqual([saved.scheme, saved.applicationNo, saved.consumerNo, saved.discom, saved.centralAmount, saved.stateAmount, saved.receivedAmount], ['PM Surya Ghar', 'PMSG-77', '170012345678', 'MSEDCL', 78000, 15000, 30000]);
  assert.equal(new Date(saved.approvedOn).toISOString().slice(0, 10), '2026-10-20');
  assert.equal(saved.creditedOn, null); // a bad date is dropped

  const cleared = await updateSubsidy(company, owner, subsidy.id, { receivedAmount: null, approvedOn: null, discom: '' });
  assert.equal(cleared.receivedAmount, null);
  assert.equal(cleared.approvedOn, null);
  assert.equal(cleared.discom, '');
  assert.equal(cleared.centralAmount, 78000); // untouched fields stay
});

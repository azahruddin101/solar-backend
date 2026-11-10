// Proposal numbers: prefix + running number + suffix, set in Settings, given to every new proposal and never reused.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Client, Company, Design } from '../src/models/index.js';
import { updateOwnCompany } from '../src/services/company.service.js';
import { createDesign, duplicateDesign } from '../src/services/design.service.js';
import { formatProposalNo, parseProposalNumbering, peekProposalNo } from '../src/services/proposalNumber.service.js';

let replSet;
let company;
let client;
const user = { _id: new mongoose.Types.ObjectId(), name: 'Owner', role: 'company' };
const fresh = () => Company.findById(company._id);
const make = async () => createDesign(await fresh(), user, { client: client.id, type: 'quick' });

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
});
after(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  await Design.syncIndexes();
  company = await Company.create({ name: 'Acme Solar' });
  client = await Client.create({ company: company._id, name: 'Sunil Patil', phone: '9876543210' });
});

test('the format is prefix + padded number + suffix, and the width never truncates', () => {
  assert.equal(formatProposalNo({ prefix: 'Q/', suffix: '/26-27', width: 3 }, 7), 'Q/007/26-27');
  assert.equal(formatProposalNo({ prefix: 'Q', suffix: '', width: 2 }, 1234), 'Q1234');
});

test('new proposals and copies take the next number; the default series is PRO-0001', async () => {
  const a = await make();
  const b = await make();
  const copy = await duplicateDesign(await fresh(), user, a.id);
  assert.deepEqual([a.proposalNo, b.proposalNo, copy.proposalNo], ['PRO-0001', 'PRO-0002', 'PRO-0003']);
  assert.equal(peekProposalNo(await fresh()), 'PRO-0004');
});

test('the owner sets prefix, suffix and the next number; used numbers are refused and skipped', async () => {
  await updateOwnCompany(await fresh(), { proposalNumbering: { prefix: 'SS/', suffix: '/26-27', next: '011' } });
  const a = await make();
  assert.equal(a.proposalNo, 'SS/011/26-27');
  await assert.rejects(parseProposalNumbering(await fresh(), { prefix: 'SS/', suffix: '/26-27', next: '011' }), /already used/);
  await assert.rejects(parseProposalNumbering(await fresh(), { prefix: 'a b', suffix: '', next: '1' }), /letters, digits/);
  await assert.rejects(parseProposalNumbering(await fresh(), { prefix: '', suffix: '', next: 'x' }), /digits only/);
  // a number that already exists under another series is skipped, not duplicated
  await Design.updateOne({ _id: a._id }, { $set: { proposalNo: 'SS/013/26-27' } });
  const [b, c] = [await make(), await make()];
  assert.deepEqual([b.proposalNo, c.proposalNo], ['SS/012/26-27', 'SS/014/26-27']);
});

test('proposals created at the same moment never share a number', async () => {
  const made = await Promise.all(Array.from({ length: 6 }, () => make()));
  assert.equal(new Set(made.map((d) => d.proposalNo)).size, 6);
});

// A proposal can carry the government subsidy the client may claim: central and state amounts, only when it applies.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client, Company, Design, User } from '../src/models/index.js';
import { createDesign, updateDesign } from '../src/services/design.service.js';

let server;
let company;
let owner;
let client;

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
  client = await Client.create({ company: company._id, name: 'Sita' });
});

test('the subsidy is stored with its amounts, and cleared when switched off', async () => {
  const created = await createDesign(company, owner, { client: String(client._id), name: 'Sita roof', type: 'quick', subsidy: { enabled: true, central: 78000, state: '15000.5' } });
  let d = await Design.findById(created.id).lean();
  assert.deepEqual(d.subsidy, { enabled: true, central: 78000, state: 15000.5 });

  const saved = await updateDesign(company, owner, created.id, { subsidy: { enabled: false, central: 78000, state: 15000 } });
  assert.deepEqual(saved.subsidy, { enabled: false, central: 0, state: 0 }); // off: no amounts linger
  d = await Design.findById(created.id).lean();
  assert.equal(d.subsidy.enabled, false);

  const plain = await createDesign(company, owner, { client: String(client._id), name: 'No subsidy', type: 'quick' });
  assert.equal((await Design.findById(plain.id).lean()).subsidy.enabled, false);
});

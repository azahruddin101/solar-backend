// The AMC visits lists (company and staff) carry every AMC on the schedule, for the tracker's AMC name filter.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Company } from '../src/models/index.js';
import { listAmcVisits } from '../src/services/amc.service.js';
let server;
before(async () => { server = await MongoMemoryServer.create(); await mongoose.connect(server.getUri()); });
after(async () => { await mongoose.disconnect(); await server?.stop(); });
test('staff list carries the schedule names', async () => {
  const c = await Company.create({ name: 'A', amcTemplates: [{ name: 'AMC1' }, { name: 'AMC2', kind: 'optional', price: 5 }] });
  const res = await listAmcVisits({ _id: c._id }, { agentId: new mongoose.Types.ObjectId() });
  assert.deepEqual(res.amcNames, ['AMC1', 'AMC2']);
});

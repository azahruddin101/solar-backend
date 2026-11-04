// Saved estimates (Dashboard → Estimation), against an in-memory MongoDB.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Company } from '../src/models/index.js';
import { estimateService as svc } from '../src/services/estimate.service.js';

let server;
let company;
const user = { name: 'Farah' };
const body = (over = {}) => ({
  client: { name: 'Ravi Kumar', phone: '99999' },
  date: '2026-11-04',
  withGst: true,
  lines: [
    { kind: 'service', name: 'Installation', qty: 1, rate: 12000, gstPercent: 18 },
    { kind: 'product', refId: 'abc', name: 'Cable', qty: 40, rate: 55, gstPercent: 12 },
  ],
  ...over,
});

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
});

test('totals are worked out by the server, with and without GST', async () => {
  const e = await svc.create(company, user, body());
  assert.equal(e.subtotal, 14200);
  assert.equal(e.gstTotal, 2424); // 2160 + 264
  assert.equal(e.total, 16624);
  const plain = await svc.update(company, e.id, body({ withGst: false }));
  assert.equal(plain.gstTotal, 0);
  assert.equal(plain.total, 14200);
});

test('a client name and an item are required; a hand-typed service is kept', async () => {
  await assert.rejects(svc.create(company, user, body({ client: { name: ' ' } })), /Client name/);
  await assert.rejects(svc.create(company, user, body({ lines: [] })), /at least one item/);
  const e = await svc.create(company, user, body({ lines: [{ kind: 'service', name: 'Roof cleaning', qty: 1, rate: 500 }] }));
  assert.equal(e.lines[0].name, 'Roof cleaning');
});

test('estimates are private to their company; the list leaves out the lines', async () => {
  const e = await svc.create(company, user, body());
  const other = await Company.create({ name: 'Other Co' });
  await assert.rejects(svc.get(other, e.id), /not found/i);
  assert.equal((await svc.list(other)).length, 0);
  const [row] = await svc.list(company, { q: 'ravi' });
  assert.equal(row.total, 16624);
  assert.ok(!row.lines?.length);
  await svc.remove(company, e.id);
  assert.equal((await svc.list(company)).length, 0);
});

// The company (organization) dashboard: each branch carries the same sales & money numbers as its own dashboard, and
// the company-wide insights add them up — with rates (win rate, billed %) worked out again, never averaged.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.S3_BUCKET = '';

const { Organization, Company, User, Client, Design, Payment } = await import('../src/models/index.js');
const { leadModels } = await import('../src/integrations/leads.js');
const { getOrganizationOverview } = await import('../src/services/organization.service.js');
const { ROLES } = await import('../src/constants/index.js');

let server;
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
});

const priced = (total, kwp = 0) => ({ kwp, pricing: { total } });

async function seed() {
  const org = await Organization.create({ name: 'Sunrise', limits: { maxBranches: 3 } });
  const [a, b] = await Company.create([
    { organization: org._id, name: 'A' },
    { organization: org._id, name: 'B' },
  ]);
  const admin = await User.create({ email: 'admin@x.co', passwordHash: 'x', role: ROLES.COMPANY, organization: org._id, company: a._id });
  const ca = await Client.create({ company: a._id, name: 'Client a' });
  const cb = await Client.create({ company: b._id, name: 'Client b' });
  const [wonA] = await Design.create([
    { company: a._id, client: ca._id, name: 'won A', status: 'won', summary: priced(100000, 5) },
    { company: a._id, client: ca._id, name: 'open A', status: 'proposed', summary: priced(40000) },
    { company: a._id, client: ca._id, name: 'lost A', status: 'lost', summary: priced(10000) },
    { company: b._id, client: cb._id, name: 'won B', status: 'won', summary: priced(50000, 3) },
    { company: b._id, client: cb._id, name: 'nego B', status: 'negotiation', summary: priced(60000) },
  ]);
  await Payment.create({ company: a._id, design: wonA._id, client: ca._id, receiptNo: 'B-1', amount: 30000 });
  await leadModels.manual.create({ company: a._id, fullName: 'Lead one', phone: '9000000001' });
  await leadModels.manual.create({ company: b._id, fullName: 'Lead two', phone: '9000000002' });
  return { admin, a, b };
}

test('each branch gets its own sales & money numbers', async () => {
  const { admin, a, b } = await seed();
  const d = await getOrganizationOverview(admin);
  const ia = d.branches.find((x) => x.id === String(a._id)).insights;
  const ib = d.branches.find((x) => x.id === String(b._id)).insights;

  assert.equal(ia.pipelineValue, 40000);
  assert.equal(ia.bookedValue, 100000);
  assert.equal(ia.winRate, 50); // 1 won of 2 decided
  assert.equal(ia.money.billed, 30000);
  assert.equal(ia.money.yetToBill, 70000);
  assert.equal(ia.thisMonth, 30000);

  assert.equal(ib.pipelineValue, 60000);
  assert.equal(ib.winRate, 100);
  assert.equal(ib.money.billed, 0);
});

test('the company-wide insights add the branches up and work the rates out again', async () => {
  const { admin } = await seed();
  const d = await getOrganizationOverview(admin);
  const t = d.insights;

  assert.equal(t.pipelineValue, 100000);
  assert.equal(t.pipelineCount, 2);
  assert.equal(t.bookedValue, 150000);
  assert.equal(t.bookedCount, 2);
  assert.equal(t.bookedKwp, 8);
  assert.equal(t.winRate, 67); // 2 won of 3 decided — not the average of 50% and 100%
  assert.equal(t.averageDeal, 75000);
  assert.deepEqual(t.money, { quoted: 150000, billed: 30000, yetToBill: 120000, billedPct: 20 });
  assert.equal(t.revenue.length, 12);
  assert.equal(t.revenue.at(-1).amount, 30000);
  assert.equal(t.thisMonth, 30000);
  assert.equal(t.stages.won.count, 2);
  assert.equal(d.totals.leadsThisMonth, 2);
  assert.equal(d.currency, 'INR');
});

test('a company without branches has no insights yet', async () => {
  const org = await Organization.create({ name: 'Empty' });
  const admin = await User.create({ email: 'e@x.co', passwordHash: 'x', role: ROLES.COMPANY, organization: org._id });
  const d = await getOrganizationOverview(admin);
  assert.equal(d.insights, null);
  assert.deepEqual(d.branches, []);
});

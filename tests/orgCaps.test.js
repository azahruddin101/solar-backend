// Company-wide caps: branches, clients and designs. Clients and designs are counted across ALL of a company's branches.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const { Client, Company, Design, Organization, Plan, User } = await import('../src/models/index.js');
const { createClient } = await import('../src/services/client.service.js');
const { createDesign, duplicateDesign } = await import('../src/services/design.service.js');
const { usageOf } = await import('../src/services/orgLimits.service.js');
const { migrateOrgCaps } = await import('../src/migrations/orgCaps.migration.js');
const { applyPlanToOrganization } = await import('../src/services/plan.service.js');
const { updateCompanyAsAdmin } = await import('../src/services/company.service.js');

let replSet;
let org;
let pune;
let mumbai;
let user;

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
  org = await Organization.create({ name: 'Sunrise', hasBranches: true, limits: { maxBranches: 3, maxClients: 3, maxDesigns: 2, maxConcurrentLogins: 5 } });
  pune = await Company.create({ name: 'Pune', organization: org._id });
  mumbai = await Company.create({ name: 'Mumbai', organization: org._id });
  user = await User.create({ email: 'o@x.test', passwordHash: 'x', name: 'Owner', company: pune._id, role: 'branch' });
});

const as = (branch) => Company.findById(branch._id); // the branch as the request sees it, with `organization`
const clientIn = async (branch, name) => createClient(await as(branch), user, { name, phone: '9876543210', createLogin: false });

test('clients are counted across all branches together', async () => {
  await clientIn(pune, 'A');
  await clientIn(pune, 'B');
  await clientIn(mumbai, 'C'); // 3 between the two branches: the cap
  await assert.rejects(clientIn(mumbai, 'D'), /limit of 3 clients, counted across all branches/);
  await assert.rejects(clientIn(pune, 'E'), /limit of 3 clients/); // the other branch is full too
  assert.equal(await Client.countDocuments(), 3);
  assert.deepEqual(await usageOf(await as(pune)), { branches: 2, clients: 3, designs: 0 });
});

test('designs are counted across all branches together, duplicating included', async () => {
  const a = await clientIn(pune, 'A');
  const b = await clientIn(mumbai, 'B');
  const first = await createDesign(await as(pune), user, { client: a.id });
  await createDesign(await as(mumbai), user, { client: b.id }); // 2 between the branches: the cap
  await assert.rejects(createDesign(await as(pune), user, { client: a.id }), /limit of 2 designs, counted across all branches/);
  await assert.rejects(duplicateDesign(await as(pune), user, first.id), /limit of 2 designs/);
  assert.equal(await Design.countDocuments(), 2);
});

test('raising the cap lets the company add more; lowering below what it holds is refused and nothing is deleted', async () => {
  await clientIn(pune, 'A');
  await clientIn(mumbai, 'B');
  await clientIn(mumbai, 'C');
  await assert.rejects(updateCompanyAsAdmin(pune.id, { limits: { maxClients: 2 } }), /already has 3 clients/);
  await updateCompanyAsAdmin(pune.id, { limits: { maxClients: 10 } });
  assert.equal((await Organization.findById(org._id)).limits.maxClients, 10);
  await clientIn(pune, 'D');
  assert.equal(await Client.countDocuments(), 4);
});

test('a plan sets the caps on the organization; a company without branches keeps one branch', async () => {
  const plan = await Plan.create({ code: 'big', name: 'Big', priceMonthly: 100, maxConcurrentLogins: 5, maxBranches: 7, maxClients: 800, maxDesigns: 1600 });
  applyPlanToOrganization(org, plan);
  assert.deepEqual([org.limits.maxBranches, org.limits.maxClients, org.limits.maxDesigns], [7, 800, 1600]);
  const solo = new Organization({ name: 'Solo', hasBranches: false });
  applyPlanToOrganization(solo, plan);
  assert.deepEqual([solo.limits.maxBranches, solo.limits.maxClients], [1, 800]);
});

test('migration: caps come from the plan, never below what the company already has, and it runs once', async () => {
  const basic = await Plan.create({ code: 'basic', name: 'Basic', priceMonthly: 30, maxConcurrentLogins: 2, maxBranches: 1, maxClients: 2, maxDesigns: 2 });
  await Organization.updateOne({ _id: org._id }, { $set: { planRef: basic._id, capsMigrated: false } });
  for (const n of ['A', 'B', 'C', 'D']) await Client.collection.insertOne({ company: pune._id, name: n, createdAt: new Date() });
  await migrateOrgCaps();
  const after1 = await Organization.findById(org._id);
  assert.equal(after1.limits.maxClients, 4); // plan says 2, but it already has 4
  assert.equal(after1.limits.maxDesigns, 2);
  assert.equal(after1.limits.maxBranches, 3); // keeps the 3 it was set to, which is above the plan's 1
  await Organization.updateOne({ _id: org._id }, { $set: { 'limits.maxClients': 99 } });
  await migrateOrgCaps(); // already migrated: leaves the admin's number alone
  assert.equal((await Organization.findById(org._id)).limits.maxClients, 99);
});

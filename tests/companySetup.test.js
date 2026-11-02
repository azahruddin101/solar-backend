// How companies are set up and kept consistent. The platform admin chooses whether a company has branches:
//  - without: one branch and one sign-in, its owner, who also manages the masters — no company admin exists;
//  - with: the given email is the company admin and every branch owner signs in with an email of their own.
// No derived "+org" logins anywhere. Writes are transactional (nothing half-made) and serialized per company (limits
// hold under concurrency); deleting a branch never deletes the company admin; old data is repaired at start-up.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

process.env.S3_BUCKET = '';

const { Organization, Company, User, AuthSession, Notification } = await import('../src/models/index.js');
const { createOrganizationWithBranch, createBranch, updateBranchCaps } = await import('../src/services/organization.service.js');
const { deleteCompany, updateCompanyAsAdmin, resetCompanyPassword } = await import('../src/services/company.service.js');
const { login, userView, organizationView } = await import('../src/services/auth.service.js');
const { migrateCompanySetup } = await import('../src/migrations/companySetup.migration.js');
const { managesMasters, orgHasBranches } = await import('../src/constants/tenant.js');
const { adminCompanyCreateSchema } = await import('../src/validation/schemas.js');
const { ROLES } = await import('../src/constants/index.js');
const { verifyPassword } = await import('../src/utils/password.js');

let replSet;
before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
});
after(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
beforeEach(async () => {
  await Promise.all([User, Company, Organization, AuthSession, Notification].map((M) => M.deleteMany({})));
});

const PW = 'Goodpass123';
const solo = (extra = {}) => createOrganizationWithBranch({ name: 'Solo Solar', loginEmail: 'owner@solo.in', password: PW, ...extra });
const multi = (extra = {}) => createOrganizationWithBranch({
  name: 'Multi Solar', hasBranches: true, loginEmail: 'admin@multi.in', password: PW,
  branchName: 'Pune', branchOwnerEmail: 'pune@multi.in', branchOwnerPassword: PW, limits: { maxBranches: 3, maxConcurrentLogins: 6 }, ...extra,
});
const counts = async () => ({ orgs: await Organization.countDocuments(), branches: await Company.countDocuments(), users: await User.countDocuments() });

/* ───────────── creating a company ───────────── */

test('without branches: one company, one owner sign-in on the given email, and that owner manages the masters', async () => {
  const { organizationId, hasBranches } = await solo({ limits: { maxBranches: 5 } });
  assert.equal(hasBranches, false);
  const org = await Organization.findById(organizationId);
  assert.equal(org.hasBranches, false);
  assert.equal(org.limits.maxBranches, 1); // a company without branches always has exactly one
  const branches = await Company.find({ organization: org._id });
  assert.deepEqual(branches.map((b) => b.name), ['Solo Solar']);

  const users = await User.find({ organization: org._id });
  assert.deepEqual(users.map((u) => [u.email, u.role]), [['owner@solo.in', ROLES.BRANCH]]);
  assert.equal(await User.exists({ email: /\+org@/ }), null);

  const owner = users[0];
  assert.equal(managesMasters(owner, org), true);
  assert.equal((await userView(owner)).managesMasters, true);
  assert.equal((await organizationView(owner, org)).hasBranches, false);
  await assert.rejects(createBranch(owner, { name: 'Second', ownerEmail: 'b@solo.in', ownerPassword: PW }), /without branches/);
});

test('with branches: the given email is the company admin and the first branch has its own owner', async () => {
  const { organizationId } = await multi();
  const org = await Organization.findById(organizationId);
  assert.equal(org.hasBranches, true);
  assert.equal(org.limits.maxBranches, 3);

  const admin = await User.findOne({ email: 'admin@multi.in' });
  const owner = await User.findOne({ email: 'pune@multi.in' });
  assert.equal(admin.role, ROLES.COMPANY);
  assert.equal(owner.role, ROLES.BRANCH);
  assert.equal(String(owner.company), String(admin.company));
  assert.equal((await Company.findById(owner.company)).name, 'Pune');
  assert.equal(await User.exists({ email: /\+org@/ }), null);
  assert.ok(await verifyPassword(PW, owner.passwordHash));

  assert.equal(managesMasters(admin, org), true);
  assert.equal(managesMasters(owner, org), false); // branch owners follow the company admin's masters
  assert.equal((await userView(owner)).managesMasters, false);
});

test('how a company was set up can never be changed afterwards', async () => {
  const { organizationId } = await solo();
  const org = await Organization.findById(organizationId);
  org.hasBranches = true;
  await org.save();
  assert.equal((await Organization.findById(organizationId)).hasBranches, false);
});

test('a refused or failed creation leaves nothing behind', async () => {
  const base = { name: 'Clash Solar', hasBranches: true, loginEmail: 'admin@clash.in', password: PW, branchOwnerPassword: PW };
  await assert.rejects(createOrganizationWithBranch({ ...base, branchOwnerEmail: 'admin@clash.in' }), /different email/);
  await assert.rejects(createOrganizationWithBranch({ ...base }), /first branch’s owner/);
  await User.create({ email: 'taken@clash.in', passwordHash: 'x', role: ROLES.AGENT });
  await assert.rejects(createOrganizationWithBranch({ ...base, branchOwnerEmail: 'taken@clash.in' }), /already in use/);
  await assert.rejects(createOrganizationWithBranch({ ...base, loginEmail: 'taken@clash.in', branchOwnerEmail: 'x@clash.in' }), /already in use/);
  assert.deepEqual(await counts(), { orgs: 0, branches: 0, users: 1 });
});

test('two creations racing for the same email: exactly one company exists afterwards', async () => {
  const results = await Promise.allSettled([solo(), solo({ name: 'Other Solar' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /already in use/);
  assert.deepEqual(await counts(), { orgs: 1, branches: 1, users: 1 });
});

test('the create form asks for the branch owner only when the company has branches', () => {
  const base = { name: 'Acme Solar', loginEmail: 'a@acme.co', password: PW };
  assert.equal(adminCompanyCreateSchema.safeParse(base).success, true);
  const missing = adminCompanyCreateSchema.safeParse({ ...base, hasBranches: true });
  assert.deepEqual(missing.error.issues.map((i) => i.path.join('.')).sort(), ['branchOwnerEmail', 'branchOwnerPassword']);
  const same = adminCompanyCreateSchema.safeParse({ ...base, hasBranches: true, branchOwnerEmail: 'a@acme.co', branchOwnerPassword: PW });
  assert.match(same.error.issues[0].message, /different email/);
  assert.equal(adminCompanyCreateSchema.safeParse({ ...base, hasBranches: true, branchOwnerEmail: 'b@acme.co', branchOwnerPassword: PW }).success, true);
});

/* ───────────── branches ───────────── */

test('every new branch has its own owner email, and gets the sign-ins the others leave free', async () => {
  await multi({ limits: { maxBranches: 3, maxConcurrentLogins: 2 } });
  const admin = await User.findOne({ email: 'admin@multi.in' });
  await assert.rejects(createBranch(admin, { name: 'Mumbai' }), /owner’s email and password/);
  await assert.rejects(createBranch(admin, { name: 'Mumbai', ownerEmail: 'pune@multi.in', ownerPassword: PW }), /already in use/);
  // the first branch holds the whole pool (2): free some up before adding another branch
  await assert.rejects(createBranch(admin, { name: 'Mumbai', ownerEmail: 'mumbai@multi.in', ownerPassword: PW }), /Lower a branch’s sign-in limit/);
  await updateBranchCaps(admin, admin.company, { limits: { maxConcurrentLogins: 1 } });
  const made = await createBranch(admin, { name: 'Mumbai', ownerEmail: 'mumbai@multi.in', ownerPassword: PW });
  assert.equal(made.owner.email, 'mumbai@multi.in');
  assert.equal(made.branch.limits.maxConcurrentLogins, 1);
  await assert.rejects(updateBranchCaps(admin, made.branch.id, { limits: { maxConcurrentLogins: 2 } }), /cannot exceed the company pool/);
});

test('branches created at the same moment never pass the branch limit', async () => {
  await multi({ limits: { maxBranches: 3, maxConcurrentLogins: 20 } });
  const admin = await User.findOne({ email: 'admin@multi.in' });
  await updateBranchCaps(admin, admin.company, { limits: { maxConcurrentLogins: 2 } });
  const results = await Promise.allSettled(['a', 'b', 'c', 'd', 'e'].map((k) => createBranch(admin, { name: `Branch ${k}`, ownerEmail: `${k}@multi.in`, ownerPassword: PW })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2); // 1 existing + 2 = the limit of 3
  for (const r of results.filter((x) => x.status === 'rejected')) assert.match(r.reason.message, /at most 3 branches/);
  assert.equal(await Company.countDocuments(), 3);
  assert.equal(await User.countDocuments({ role: ROLES.BRANCH }), 3); // no owner without a branch
});

/* ───────────── signing in ───────────── */

test('a company admin login only works in a company with branches', async () => {
  const { organizationId } = await solo();
  const branch = await Company.findOne({ organization: organizationId });
  // a stray admin login (as the old "+org" setup made) cannot get in
  await User.create({ email: 'stray@solo.in', passwordHash: (await User.findOne({ email: 'owner@solo.in' })).passwordHash, role: ROLES.COMPANY, organization: organizationId, company: branch._id });
  await assert.rejects(login({ email: 'stray@solo.in', password: PW }), /Incorrect email or password/);
  const ok = await login({ email: 'owner@solo.in', password: PW });
  assert.equal(ok.user.role, ROLES.BRANCH);
  assert.equal(ok.user.managesMasters, true);
});

/* ───────────── platform admin ───────────── */

test('deleting a branch moves the company admin to another branch; deleting the last one removes the whole company', async () => {
  await multi();
  const admin = await User.findOne({ email: 'admin@multi.in' });
  await updateBranchCaps(admin, admin.company, { limits: { maxConcurrentLogins: 2 } });
  const second = await createBranch(admin, { name: 'Mumbai', ownerEmail: 'mumbai@multi.in', ownerPassword: PW });

  await deleteCompany(admin.company); // the branch the admin works in
  const moved = await User.findOne({ email: 'admin@multi.in' });
  assert.ok(moved, 'the company admin was deleted with a branch');
  assert.equal(String(moved.company), second.branch.id);
  assert.equal(await User.exists({ email: 'pune@multi.in' }), null);
  assert.equal(await Organization.countDocuments(), 1);

  await deleteCompany(second.branch.id);
  assert.deepEqual(await counts(), { orgs: 0, branches: 0, users: 0 });
});

test('the platform admin can change and reset the company admin’s sign-in, and the sign-in pool stays consistent', async () => {
  await multi();
  const admin = await User.findOne({ email: 'admin@multi.in' });
  const branchId = String(admin.company);

  await updateCompanyAsAdmin(branchId, { adminEmail: 'boss@multi.in' });
  assert.ok(await User.exists({ email: 'boss@multi.in', role: ROLES.COMPANY }));
  await assert.rejects(updateCompanyAsAdmin(branchId, { adminEmail: 'pune@multi.in' }), /already in use/);

  await resetCompanyPassword(branchId, 'Newpass456', 'admin');
  assert.ok(await verifyPassword('Newpass456', (await User.findOne({ email: 'boss@multi.in' })).passwordHash));
  assert.ok(await verifyPassword(PW, (await User.findOne({ email: 'pune@multi.in' })).passwordHash)); // owner untouched

  // the pool (6) is held by the first branch: it can't be cut below that, and the branch cap is not overwritten
  await assert.rejects(updateCompanyAsAdmin(branchId, { limits: { maxConcurrentLogins: 2 } }), /already hold 6 sign-ins/);
  await updateCompanyAsAdmin(branchId, { limits: { maxConcurrentLogins: 10 } });
  assert.equal((await Organization.findOne()).limits.maxConcurrentLogins, 10);
  assert.equal((await Company.findById(branchId)).limits.maxConcurrentLogins, 6);
  // the branch limit can't go below the branches that exist
  const boss = await User.findOne({ email: 'boss@multi.in' });
  await createBranch(boss, { name: 'Mumbai', ownerEmail: 'mumbai@multi.in', ownerPassword: PW });
  await assert.rejects(updateCompanyAsAdmin(branchId, { limits: { maxBranches: 1 } }), /already has 2 branches/);
  await updateCompanyAsAdmin(branchId, { limits: { maxBranches: 2 } });
  assert.equal((await Organization.findOne()).limits.maxBranches, 2);
});

test('a company without branches: no admin email to set, and its branch limit stays at one', async () => {
  const { organizationId } = await solo();
  const branch = await Company.findOne({ organization: organizationId });
  await assert.rejects(updateCompanyAsAdmin(branch.id, { adminEmail: 'x@solo.in' }), /set up without branches/);
  await updateCompanyAsAdmin(branch.id, { limits: { maxBranches: 4, maxConcurrentLogins: 3 } });
  const org = await Organization.findById(organizationId);
  assert.equal(org.limits.maxBranches, 1);
  assert.equal(org.limits.maxConcurrentLogins, 3);
  assert.equal((await Company.findById(branch.id)).limits.maxConcurrentLogins, 3);
});

/* ───────────── repairing old data ───────────── */

async function legacyOrg({ name, branches, admin, owner }) {
  const { insertedId } = await Organization.collection.insertOne({ name, limits: { maxBranches: 3, maxConcurrentLogins: 2 } }); // no hasBranches: made before the choice
  const made = [];
  for (const b of branches) made.push(await Company.create({ organization: insertedId, name: b }));
  const users = [];
  if (owner) users.push(await User.create({ email: owner, passwordHash: 'x', role: ROLES.BRANCH, organization: insertedId, company: made[0]._id }));
  if (admin) users.push(await User.create({ email: admin, passwordHash: 'x', role: ROLES.COMPANY, organization: insertedId, company: made[0]._id }));
  return { orgId: insertedId, branches: made, users };
}

test('start-up repair: old companies get their setup, derived "+org" admins are removed or given their real email', async () => {
  const single = await legacyOrg({ name: 'Old Single', branches: ['Main'], owner: 'one@old.in', admin: 'one+org@old.in' });
  await AuthSession.create({ user: single.users[1]._id, sessionId: 's1', company: single.branches[0]._id, expiresAt: new Date(Date.now() + 3600e3) });
  const clash = await legacyOrg({ name: 'Old Multi', branches: ['A', 'B'], owner: 'two@old.in', admin: 'two+org@old.in' });
  const free = await legacyOrg({ name: 'Old Multi Free', branches: ['C', 'D'], admin: 'three+org@old.in' });

  await migrateCompanySetup();

  const o1 = await Organization.findById(single.orgId);
  assert.equal(o1.hasBranches, false);
  assert.equal(o1.limits.maxBranches, 1);
  assert.equal(await User.exists({ email: 'one+org@old.in' }), null);
  assert.equal(await AuthSession.countDocuments({ user: single.users[1]._id }), 0);
  assert.ok(await User.exists({ email: 'one@old.in', role: ROLES.BRANCH }));

  assert.equal((await Organization.findById(clash.orgId)).hasBranches, true);
  // the real address belongs to the branch owner: left for the platform admin to choose (Admin → Companies → Edit)
  assert.ok(await User.exists({ email: 'two+org@old.in', role: ROLES.COMPANY }));

  assert.equal((await Organization.findById(free.orgId)).hasBranches, true);
  assert.ok(await User.exists({ email: 'three@old.in', role: ROLES.COMPANY }));

  // a second run changes nothing
  const before = await User.find().sort({ email: 1 }).lean();
  await migrateCompanySetup();
  assert.deepEqual((await User.find().sort({ email: 1 }).lean()).map((u) => u.email), before.map((u) => u.email));
  assert.equal(orgHasBranches(await Organization.findById(single.orgId)), false);
});

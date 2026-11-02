// Access rules that must hold (bug audit group 3):
//  - "their team" really limits clients and installations, on lists AND on every route that names one record;
//  - a lead handed to someone else is read-only for its previous holder;
//  - a team manager only reads assignment history of leads they can see;
//  - branch owners can use client support;
//  - suspending one branch never locks the company admin out;
//  - the company admin's devices never use up, or sign out, a branch owner's.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.S3_BUCKET = '';
process.env.JWT_SECRET ||= 'test-only-secret';

const { Organization, Company, User, Client, Design, Project, AuthSession, ClientTicket } = await import('../src/models/index.js');
const { normalizePermissions, upgradePermissions, ROLE_TEMPLATES } = await import('../src/constants/permissions.js');
const { listClientTickets } = await import('../src/services/clientTicket.service.js');
const { login } = await import('../src/services/auth.service.js');
const { hashPassword } = await import('../src/utils/password.js');
const { startLeadsApp, mkUser, ManualLead, MetaLead, MetaLeadStatus, MetaLeadAssignment } = await import('./helpers/leadsApp.js');

let server, leads, http, base, current;
before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  leads = await startLeadsApp();
  // clients + installations routes with the signed-in user of the test
  const { default: clientRoutes } = await import('../src/routes/client.routes.js');
  const { projectRoutes } = await import('../src/routes/project.routes.js');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = current.user; req.company = current.company; next(); });
  app.use('/api/clients', clientRoutes);
  app.use('/api/projects', projectRoutes);
  app.use((err, req, res, next) => res.status(err.status || err.statusCode || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  await new Promise((resolve) => { http = app.listen(0, resolve); });
  base = `http://127.0.0.1:${http.address().port}`;
});
after(async () => {
  await leads?.stop();
  http?.close();
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
});

const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const signIn = async (user, company) => {
  const u = await User.findById(user._id);
  u.effectivePermissions = [...(u.permissions || [])];
  current = { user: u, company: await Company.findById(company._id) };
};

/* ───────────── "their team" ───────────── */

test('the area-manager role never brings "view all" for clients or installations; old roles are upgraded once', () => {
  const area = ROLE_TEMPLATES.find((t) => t.key === 'area_manager');
  const perms = normalizePermissions(area.permissions);
  assert.ok(perms.includes('clients:view_team') && perms.includes('tasks:view_team'));
  assert.ok(!perms.includes('clients:view') && !perms.includes('tasks:view'));
  assert.ok(perms.includes('leads:view')); // leads: "view" is only their own, so it still comes along
  assert.ok(normalizePermissions(['clients:create']).includes('clients:view')); // without a team scope, any action still brings view
  assert.deepEqual(upgradePermissions(['clients:view', 'clients:view_team', 'tasks:view', 'tasks:view_team', 'tasks:assign'], 5), ['clients:view_team', 'tasks:assign', 'tasks:view_team']);
});

test('a team manager only reaches their team’s clients and installations — lists and every route that names one', async () => {
  const company = await Company.create({ name: 'Co' });
  const mgr = await mkUser(company, { role: 'agent', permissions: normalizePermissions(['clients:view_team', 'tasks:view_team', 'tasks:change_status']) });
  const report = await mkUser(company, { role: 'agent', manager: mgr._id, permissions: ['leads:view'] });
  const [mine, other] = await Client.create([{ company: company._id, name: 'Team Client' }, { company: company._id, name: 'Other Client' }]);
  await ManualLead.create({ company: company._id, source: 'manual', fullName: 'L', phone: '9000000001', phoneKey: '9000000001', assignedTo: report._id, convertedClient: mine._id });
  const [d1, d2] = await Design.create([{ company: company._id, client: mine._id, name: 'D1', status: 'won' }, { company: company._id, client: other._id, name: 'D2', status: 'won' }]);
  const [p1, p2] = await Project.create([
    { company: company._id, design: d1._id, client: mine._id, steps: [{ name: 'Wiring', assignee: report._id }] },
    { company: company._id, design: d2._id, client: other._id, steps: [{ name: 'Wiring' }] },
  ]);
  await signIn(mgr, company);

  const list = await call('GET', '/api/clients');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.map((c) => c.name), ['Team Client']);
  assert.equal((await call('GET', `/api/clients/${mine._id}`)).status, 200);
  assert.equal((await call('GET', `/api/clients/${other._id}`)).status, 404);
  assert.equal((await call('GET', `/api/clients/${other._id}/overview`)).status, 404);

  const projects = await call('GET', '/api/projects');
  assert.deepEqual(projects.body.items.map((p) => String(p.id)), [String(p1._id)]);
  assert.equal((await call('GET', `/api/projects/${p2._id}`)).status, 404);
  const step = p2.steps[0]._id;
  assert.equal((await call('PUT', `/api/projects/${p2._id}/steps/${step}`, { status: 'in_progress' })).status, 404); // writes too
  assert.equal((await call('GET', '/api/projects/amc-visits')).status, 403); // company-wide boards need "view all"
  const board = await call('GET', '/api/projects/board');
  assert.equal(board.status, 200);
  assert.ok(!JSON.stringify(board.body).includes('D2'));
});

/* ───────────── leads ───────────── */

async function leadsSetup() {
  const company = await Company.create({ name: 'Co' });
  const owner = await mkUser(company, { role: 'branch' });
  await leads.as(owner, company);
  await leads.call('GET', '/api/leads/statuses'); // creates the default statuses
  return { company, owner };
}

test('a lead handed to someone else is read-only for its previous holder (manual and Meta)', async () => {
  const { company, owner } = await leadsSetup();
  const a = await mkUser(company, { role: 'agent', permissions: ['leads:view', 'leads:change_status', 'leads:update'] });
  const b = await mkUser(company, { role: 'agent', permissions: ['leads:view', 'leads:change_status'] });
  const lost = await MetaLeadStatus.findOne({ company: company._id, outcome: 'lost' });
  const lead = await ManualLead.create({ company: company._id, source: 'manual', fullName: 'L', phone: '9000000003', phoneKey: '9000000003' });
  const meta = await MetaLead.create({ company: company._id, externalLeadId: '111', processingStatus: 'processed', pageId: '1', formId: '2' });
  for (const to of [a, b]) {
    await leads.call('POST', '/api/leads/manual/assign', { leadIds: [String(lead._id)], counsellorId: String(to._id) });
    await leads.call('POST', '/api/leads/meta/assign', { leadIds: [String(meta._id)], counsellorId: String(to._id) });
  }

  await leads.as(a, company);
  assert.equal((await leads.call('PUT', `/api/leads/manual/${lead._id}/status`, { statusId: String(lost._id) })).status, 404);
  assert.equal((await leads.call('PUT', `/api/leads/manual/${lead._id}/priority`, { isPriority: true })).status, 404);
  assert.equal((await leads.call('PUT', `/api/leads/meta/${meta._id}/status`, { statusId: String(lost._id) })).status, 404);
  const track = await MetaLeadAssignment.findOne({ lead: meta._id, isActive: true }).lean();
  assert.notEqual(String(track.currentStatus), String(lost._id)); // B's track untouched
  // still visible to A (their history), just not editable
  assert.equal((await leads.call('GET', '/api/leads/manual')).body.total, 1);

  await leads.as(b, company);
  assert.equal((await leads.call('PUT', `/api/leads/manual/${lead._id}/status`, { statusId: String(lost._id) })).status, 200);
});

test('a team manager only reads the assignment history of leads they can see', async () => {
  const { company, owner } = await leadsSetup();
  const mgr = await mkUser(company, { role: 'agent', permissions: ['leads:view_team', 'leads:view'] });
  await mkUser(company, { role: 'agent', manager: mgr._id, permissions: ['leads:view'] });
  const outsider = await mkUser(company, { role: 'agent', permissions: ['leads:view'] });
  const meta = await MetaLead.create({ company: company._id, externalLeadId: '222', processingStatus: 'processed', pageId: '1', formId: '2' });
  await leads.as(owner, company);
  await leads.call('POST', '/api/leads/meta/assign', { leadIds: [String(meta._id)], counsellorId: String(outsider._id) });
  await leads.as(mgr, company);
  assert.equal((await leads.call('GET', `/api/leads/meta/${meta._id}/assignments`)).status, 404);
});

/* ───────────── client support ───────────── */

test('branch owners can use client support', async () => {
  const company = await Company.create({ name: 'Co' });
  const owner = await mkUser(company, { role: 'branch' });
  const client = await Client.create({ company: company._id, name: 'Ravi' });
  const clientUser = await mkUser(company, { role: 'client', client: client._id });
  await ClientTicket.create({ company: company._id, client: client._id, createdBy: clientUser._id, subject: 'Inverter beeping', category: 'service', messages: [{ author: clientUser._id, body: 'Beeps at night' }] });
  const result = await listClientTickets(owner, {});
  assert.equal(result.total ?? result.items?.length, 1);
});

/* ───────────── company admin sign-in ───────────── */

async function orgWithBranches() {
  const passwordHash = await hashPassword('Goodpass123');
  const org = await Organization.create({ name: 'Multi', hasBranches: true, limits: { maxBranches: 3, maxConcurrentLogins: 4 } });
  const [pune, mumbai] = await Company.create([
    { organization: org._id, name: 'Pune', limits: { maxConcurrentLogins: 2 } },
    { organization: org._id, name: 'Mumbai', limits: { maxConcurrentLogins: 2 } },
  ]);
  const admin = await User.create({ email: 'admin@multi.in', passwordHash, role: 'company', organization: org._id, company: pune._id });
  const owner = await User.create({ email: 'pune@multi.in', passwordHash, role: 'branch', organization: org._id, company: pune._id });
  return { org, pune, mumbai, admin, owner };
}

test('suspending the company admin’s branch moves them to an active branch instead of locking them out', async () => {
  const { pune, mumbai } = await orgWithBranches();
  await Company.updateOne({ _id: pune._id }, { $set: { status: 'suspended' } });
  const session = await login({ email: 'admin@multi.in', password: 'Goodpass123', ip: '1', userAgent: 'test' });
  assert.equal(session.company.id, String(mumbai._id));
  // the branch owner of the suspended branch stays out
  await assert.rejects(login({ email: 'pune@multi.in', password: 'Goodpass123', ip: '2', userAgent: 'test' }), /suspended/);
});

test('the company admin’s devices never use up, or sign out, a branch owner’s', async () => {
  const { admin, owner } = await orgWithBranches();
  for (const ip of ['1', '2']) await login({ email: 'pune@multi.in', password: 'Goodpass123', ip, userAgent: 'test' }); // owner at the branch cap (2)
  await login({ email: 'admin@multi.in', password: 'Goodpass123', ip: '3', userAgent: 'test' }); // not blocked by the branch cap
  await login({ email: 'admin@multi.in', password: 'Goodpass123', ip: '4', userAgent: 'test', replaceSessions: true });
  assert.equal(await AuthSession.countDocuments({ user: owner._id }), 2); // making room never signs the owner out
  assert.equal(await AuthSession.countDocuments({ user: admin._id }), 1);
  // the admin's own cap is the organization's total (4)
  for (const ip of ['5', '6', '7']) await login({ email: 'admin@multi.in', password: 'Goodpass123', ip, userAgent: 'test' });
  await assert.rejects(login({ email: 'admin@multi.in', password: 'Goodpass123', ip: '8', userAgent: 'test' }), /devices signed in at once/);
});

test('the session’s company always carries its id (it keys the frontend’s caches and branch switching)', async () => {
  const { pune } = await orgWithBranches();
  for (const email of ['admin@multi.in', 'pune@multi.in']) {
    const session = await login({ email, password: 'Goodpass123', ip: email, userAgent: 'test' });
    assert.equal(session.company.id, String(pune._id));
  }
});

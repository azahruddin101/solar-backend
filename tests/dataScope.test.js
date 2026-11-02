import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ROLES } from '../src/constants/index.js';
import { Company, Organization, User } from '../src/models/index.js';
import { resolveLeadAssigneeScope, canViewStaffOverview } from '../src/services/dataScope.service.js';

let server;
let branch;
let org;

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
  org = await Organization.create({ name: 'Org A' });
  branch = await Company.create({ name: 'Branch', organization: org._id, status: 'active' });
});

test('area manager lead scope includes direct reports', async () => {
  const manager = await User.create({ email: 'mgr@test.io', passwordHash: 'x', role: ROLES.AGENT, company: branch._id, organization: org._id, permissions: ['leads:view_team'] });
  const rep = await User.create({ email: 'rep@test.io', passwordHash: 'x', role: ROLES.AGENT, company: branch._id, organization: org._id, manager: manager._id, permissions: ['leads:view'] });
  manager.effectivePermissions = ['leads:view', 'leads:view_team'];
  const scope = await resolveLeadAssigneeScope(manager);
  assert.ok(scope.$in);
  assert.ok(scope.$in.some((id) => String(id) === String(rep._id)));
  assert.ok(await canViewStaffOverview(manager, rep._id));
  assert.equal(await canViewStaffOverview(rep, manager._id), false);
});

test('branch owner can view any staff overview', async () => {
  const owner = { role: ROLES.BRANCH, _id: new mongoose.Types.ObjectId(), company: branch._id };
  const agent = await User.create({ email: 'a@test.io', passwordHash: 'x', role: ROLES.AGENT, company: branch._id });
  assert.ok(await canViewStaffOverview(owner, agent._id));
});

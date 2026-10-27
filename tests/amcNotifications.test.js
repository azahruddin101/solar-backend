// Who hears about AMC requests: the owner, and the staff whose permissions (through their roles, as they are when the
// request comes in) let them assign AMC visits — no one else.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const { env } = await import('../src/config/env.js');
const { Company, Notification, Role, User } = await import('../src/models/index.js');
const { notifyAmcRequested } = await import('../src/services/notification.service.js');

// env.js loads backend/.env, which may hold live OneSignal keys: only the inbox rows are tested, nothing is pushed
env.oneSignalAppId = '';
env.oneSignalRestApiKey = '';

let server;
before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Notification.init();
});
after(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

const person = (company, name, fields) => User.create({ company: company._id, email: `${name}@acme.test`, passwordHash: 'x', name, ...fields });

/** notify* runs in the background; wait until its inbox rows are written. */
async function inboxOf(eventId, expected) {
  for (let i = 0; i < 50; i += 1) {
    const rows = await Notification.find({ eventKey: `amc-requested:${eventId}` }).lean();
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return Notification.find({ eventKey: `amc-requested:${eventId}` }).lean();
}

test('a new AMC request reaches the owner and staff who may assign AMC visits', async () => {
  const company = await Company.create({ name: 'Acme Solar' });
  const supervisor = await Role.create({ company: company._id, name: 'Supervisor', permissions: ['tasks:view', 'tasks:assign'] });
  const viewerRole = await Role.create({ company: company._id, name: 'Viewer', permissions: ['tasks:view'] });
  const owner = await person(company, 'owner', { role: 'company' });
  const lead = await person(company, 'lead', { role: 'agent', staffRoles: [supervisor._id] });
  const direct = await person(company, 'direct', { role: 'agent', permissions: ['tasks:view', 'tasks:assign'] });
  const viewer = await person(company, 'viewer', { role: 'agent', staffRoles: [viewerRole._id] });
  await person(company, 'gone', { role: 'agent', staffRoles: [supervisor._id], active: false });
  const elsewhere = await Company.create({ name: 'Other' });
  await person(elsewhere, 'other', { role: 'agent', permissions: ['tasks:view', 'tasks:assign'] });

  notifyAmcRequested({ companyId: company._id, designName: 'Patil bungalow', packageName: 'Premium AMC', requestedDate: new Date(), eventId: 'r1' });
  const rows = await inboxOf('r1', 3);
  const to = new Map(rows.map((r) => [String(r.user), r.path]));
  assert.deepEqual([...to.keys()].sort(), [owner.id, lead.id, direct.id].sort());
  assert.equal(to.get(owner.id), '/dashboard/amc');
  assert.equal(to.get(lead.id), '/agent/amc?scope=all');
  assert.ok(!to.has(viewer.id));

  // the owner gives the Viewer role the right to assign: the next request reaches its holder too
  await Role.updateOne({ _id: viewerRole._id }, { permissions: ['tasks:view', 'tasks:assign'] });
  notifyAmcRequested({ companyId: company._id, packageName: 'Premium AMC', requestedDate: new Date(), eventId: 'r2' });
  assert.ok((await inboxOf('r2', 4)).some((r) => String(r.user) === viewer.id));
});

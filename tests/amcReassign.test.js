// An AMC visit keeps its own log, and handing it from one person to another marks it reassigned (so the tracker can
// list those) with the earlier person remembered.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client, Company, Design, Project, User } from '../src/models/index.js';
import { assignAmcRequest, assignAmcVisit, createAmcVisit, listAmcVisits, submitClientAmcRequest } from '../src/services/amc.service.js';
import { completeAmcVisit } from '../src/services/project.service.js';

let server;
let company;
let owner;
let design;
let project;
let ravi;
let sita;

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
  company = await Company.create({ name: 'Acme Solar', amcTemplates: [{ name: 'AMC1', kind: 'mandatory', price: 0, daysAfterInstallation: 60 }, { name: 'Thermal scan', kind: 'optional', price: 900 }] });
  owner = await User.create({ email: 'o@x.test', passwordHash: 'x', role: 'company', name: 'Owner', company: company._id });
  const agent = (name, email) => User.create({ email, passwordHash: 'x', role: 'agent', name, company: company._id });
  ravi = await agent('Ravi', 'r@x.test');
  sita = await agent('Sita', 's@x.test');
  const client = await Client.create({ company: company._id, name: 'Vinod' });
  design = await Design.create({ company: company._id, client: client._id, name: 'Rooftop', status: 'won' });
  project = await Project.create({ company: company._id, design: design._id, client: client._id, status: 'completed', installationCompletedAt: new Date() });
});

const visits = async () => (await listAmcVisits(company)).items;

test('a visit added by the company logs its life: added, assigned, reassigned (kept as reassigned), completed', async () => {
  const { visitId } = await createAmcVisit(company, owner, project.id, { name: 'AMC1', date: new Date(Date.now() + 86400000), note: 'phone call', assigneeId: ravi.id });
  let v = (await visits()).find((x) => x.id === visitId);
  assert.equal(v.reassigned, false);
  assert.deepEqual(v.logs.map((l) => l.action), ['amc_assigned', 'amc_added']); // newest first
  assert.equal(v.logs[0].message, 'Ravi');

  await assignAmcVisit(company, owner, project.id, visitId, sita.id);
  v = (await visits()).find((x) => x.id === visitId);
  assert.equal(v.assignee.name, 'Sita');
  assert.equal(v.reassigned, true);
  assert.equal(v.reassignedCount, 1);
  assert.deepEqual(v.previousAssignees.map((p) => p.name), ['Ravi']);
  assert.equal(v.logs[0].action, 'amc_reassigned');
  assert.equal(v.logs[0].message, 'Ravi → Sita');
  assert.equal(v.logs[0].byName, 'Owner');

  await assignAmcVisit(company, owner, project.id, visitId, sita.id); // the same person again is not a reassignment
  v = (await visits()).find((x) => x.id === visitId);
  assert.equal(v.reassignedCount, 1);

  const fresh = await Project.findById(project._id);
  const visit = fresh.amcVisits.id(visitId);
  for (const c of visit.criteria) c.checked = true;
  await fresh.save();
  await completeAmcVisit(company, { ...owner.toObject(), _id: owner._id }, project.id, visitId, { criteria: [], note: 'all good' });
  v = (await visits()).find((x) => x.id === visitId);
  assert.equal(v.logs[0].action, 'amc_completed');
  assert.equal(v.logs[0].message, 'all good');

  // the installation's own activity log carries the assignment lines too
  const logged = (await Project.findById(project._id)).logs.map((l) => l.action);
  assert.ok(logged.includes('amc_assigned') && logged.includes('amc_reassigned'));
});

test('a client booking logs the request, and assigning it from the request side counts reassignments the same way', async () => {
  const req = await submitClientAmcRequest({ company, design, packageName: 'Thermal scan', requestedDate: new Date(Date.now() + 5 * 86400000), note: 'roof is hot' });
  let v = (await visits()).find((x) => x.name === 'Thermal scan');
  assert.equal(v.logs[0].action, 'amc_requested');
  assert.equal(v.logs[0].byName, 'Client');
  assert.match(v.logs[0].message, /roof is hot/);

  await assignAmcRequest(company, owner, design.id, req.id, ravi.id);
  await assignAmcRequest(company, owner, design.id, req.id, sita.id);
  v = (await visits()).find((x) => x.name === 'Thermal scan');
  assert.equal(v.assignee.name, 'Sita');
  assert.equal(v.reassignedCount, 1);
  assert.deepEqual(v.previousAssignees.map((p) => p.name), ['Ravi']);
  assert.deepEqual(v.logs.slice(0, 2).map((l) => l.action), ['amc_reassigned', 'amc_assigned']);
});

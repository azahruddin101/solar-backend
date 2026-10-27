// Client AMC bookings against an in-memory MongoDB: an optional paid package can be booked again and again (each
// booking its own installation visit); a mandatory paid one has a single booking.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client, Company, Design, Project, User } from '../src/models/index.js';
import { createAmcVisit, listAmcVisits, markAmcRequestCompleted, submitClientAmcRequest, updateAmcTemplates } from '../src/services/amc.service.js';
import { completeAmcVisitAsAgent } from '../src/services/project.service.js';

let server;
let company;
let design;
let project;
const owner = { _id: new mongoose.Types.ObjectId(), name: 'Owner', role: 'company' };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const book = (packageName, n, extra = {}) => submitClientAmcRequest({ company, design, packageName, requestedDate: day(n), ...extra });
const reload = async () => {
  design = await Design.findById(design._id);
  project = await Project.findById(project._id);
};

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
  company = await Company.create({
    name: 'Acme Solar',
    amcTemplates: [
      { name: 'AMC1', kind: 'mandatory', price: 0, daysAfterInstallation: 60 },
      { name: 'AMC2', kind: 'optional', price: 9000 },
      { name: 'Annual check', kind: 'mandatory', price: 1500, daysAfterInstallation: 90 },
    ],
  });
  const client = await Client.create({ company: company._id, name: 'Vinod Sharma' });
  design = await Design.create({ company: company._id, client: client._id, name: 'Rooftop', status: 'won' });
  project = await Project.create({ company: company._id, design: design._id, client: client._id });
});

test('an optional package can be booked several times, each booking its own visit', async () => {
  await book('AMC2', 3);
  await book('AMC2', 30);
  await reload();
  assert.equal(design.amcRequests.length, 2);
  const visits = project.amcVisits.filter((v) => v.name === 'AMC2');
  assert.equal(visits.length, 2);
  assert.deepEqual(visits.map((v) => String(v.request)).sort(), design.amcRequests.map((r) => r.id).sort());
});

test('completing one booking leaves the others open, and a new booking after it is a new visit', async () => {
  await book('AMC2', 3);
  await reload();
  const first = project.amcVisits.find((v) => v.name === 'AMC2');
  first.status = 'completed';
  await project.save();
  await markAmcRequestCompleted(design._id, first);

  await book('AMC2', 40);
  await reload();
  assert.deepEqual(design.amcRequests.map((r) => r.status), ['completed', 'requested']);
  const visits = project.amcVisits.filter((v) => v.name === 'AMC2');
  assert.deepEqual(visits.map((v) => v.status), ['completed', 'pending']);
  assert.equal(String(visits[1].request), design.amcRequests[1].id);
});

test('changing the date of one booking does not create another', async () => {
  await book('AMC2', 3);
  await book('AMC2', 10);
  await reload();
  const second = design.amcRequests[1];
  await book('AMC2', 20, { requestId: second.id, note: 'After 5 pm' });
  await reload();
  assert.equal(design.amcRequests.length, 2);
  assert.equal(design.amcRequests[1].note, 'After 5 pm');
  assert.equal(project.amcVisits.find((v) => String(v.request) === second.id).dueDate.toISOString().slice(0, 10), new Date(`${day(20)}T00:00:00`).toISOString().slice(0, 10));
});

test('a mandatory AMC cannot be requested — the company schedules it', async () => {
  await assert.rejects(book('Annual check', 3), /your provider schedules it/);
  await assert.rejects(book('AMC1', 3), /your provider schedules it/);
  await reload();
  assert.equal(design.amcRequests.length, 0);
});

test('a free optional AMC is requested the same way as a paid one, as often as the client likes', async () => {
  company.amcTemplates.push({ name: 'Thermal scan', kind: 'optional', price: 0 });
  await company.save();
  await book('Thermal scan', 3);
  await book('Thermal scan', 9);
  await reload();
  assert.equal(design.amcRequests.length, 2);
  assert.equal(project.amcVisits.filter((v) => v.name === 'Thermal scan').length, 2);
});

test('a visit made before bookings were linked is taken over by the first booking', async () => {
  project.amcVisits.push({ name: 'AMC2', kind: 'optional', price: 9000, status: 'pending' });
  await project.save();
  await book('AMC2', 3);
  await reload();
  const visits = project.amcVisits.filter((v) => v.name === 'AMC2');
  assert.equal(visits.length, 1);
  assert.equal(String(visits[0].request), design.amcRequests[0].id);
});

test('the company can add an optional visit to an installation, and assign staff in the same step', async () => {
  const staff = await User.create({ email: 'farah@x.test', passwordHash: 'x', role: 'agent', name: 'Farah', company: company._id });
  const res = await createAmcVisit(company, owner, project.id, { name: 'AMC2', date: day(10), note: 'Client phoned', assigneeId: staff.id });
  await reload();
  const visit = project.amcVisits.id(res.visitId);
  assert.equal(visit.name, 'AMC2');
  assert.equal(visit.workflowStatus, 'assigned');
  assert.equal(String(visit.assignee), staff.id);
  const req = design.amcRequests[0];
  assert.equal(req.requestedBy, 'company');
  assert.equal(req.status, 'assigned'); // the client's portal shows it, with the technician
  assert.equal(String(visit.request), req.id);
  // the client cannot change a visit the company scheduled
  await assert.rejects(book('AMC2', 20, { requestId: req.id }), /scheduled by your provider/);
});

test('a mandatory AMC missing from an installation can be added once', async () => {
  const res = await createAmcVisit(company, owner, project.id, { name: 'Annual check', date: day(30) });
  await reload();
  assert.equal(project.amcVisits.id(res.visitId).name, 'Annual check');
  await assert.rejects(createAmcVisit(company, owner, project.id, { name: 'Annual check', date: day(40) }), /already on this installation/);
});

test('only the assigned staff member can complete a visit', async () => {
  const staff = await User.create({ email: 'a@x.test', passwordHash: 'x', role: 'agent', name: 'A', company: company._id });
  const other = await User.create({ email: 'b@x.test', passwordHash: 'x', role: 'agent', name: 'B', company: company._id });
  project.status = 'completed';
  project.amcVisits.push({ name: 'AMC1', kind: 'mandatory', status: 'pending', assignee: staff._id, assigneeName: 'A', workflowStatus: 'assigned' });
  await project.save();
  const vid = project.amcVisits.at(-1).id;
  await assert.rejects(completeAmcVisitAsAgent({ ...other.toObject(), id: other.id, company: company._id }, project.id, vid, {}), /not found|not assigned/i);
  await completeAmcVisitAsAgent({ ...staff.toObject(), id: staff.id, company: company._id }, project.id, vid, {});
  await reload();
  assert.equal(project.amcVisits.id(vid).status, 'completed');
});

test('a mandatory AMC added to the schedule later (AMC3 at 120 days) reaches installations already finished', async () => {
  const finished = new Date();
  finished.setDate(finished.getDate() - 10);
  project.status = 'completed';
  project.installationCompletedAt = finished;
  project.amcVisits.push({ name: 'AMC1', kind: 'mandatory', status: 'pending' });
  await project.save();

  // seen as soon as the tracker is opened…
  company.amcTemplates.push({ name: 'AMC3', kind: 'mandatory', price: 0, daysAfterInstallation: 120 });
  await company.save();
  const res = await listAmcVisits(company);
  const amc3 = res.items.find((i) => i.name === 'AMC3');
  assert.ok(amc3, 'AMC3 is listed so staff can be assigned');
  assert.ok(Math.abs((new Date(amc3.dueDate) - finished) / 86400000 - 120) <= 1, 'due 120 days after the installation (to the day)');
  await reload();
  assert.equal(project.amcVisits.filter((v) => v.name === 'AMC3').length, 1);
  await listAmcVisits(company); // listing again doesn't add it twice
  await reload();
  assert.equal(project.amcVisits.filter((v) => v.name === 'AMC3').length, 1);
  assert.equal(project.amcVisits.filter((v) => v.name === 'AMC1').length, 1); // existing visits are untouched

  // …and added at once when the schedule is saved
  await updateAmcTemplates(company, { templates: [...company.amcTemplates.map((t) => t.toObject()), { name: 'AMC4', kind: 'mandatory', price: 0, daysAfterInstallation: 200 }] });
  await reload();
  assert.equal(project.amcVisits.filter((v) => v.name === 'AMC4').length, 1);
});

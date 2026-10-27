// AMC emails go to all three sides — the client, the company (owners and its own address) and the staff — once per
// event and recipient, never to whoever caused the event, and never when email isn't set up. A recording transport
// stands in for SMTP; push is switched off.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const { env } = await import('../src/config/env.js');
const { Client, Company, Design, EmailLog, Role, User } = await import('../src/models/index.js');
const { setMailTransport } = await import('../src/services/mail.service.js');
const amc = await import('../src/services/amcEmail.service.js');

env.oneSignalAppId = '';
env.oneSignalRestApiKey = '';
env.smtp.host = '';
env.smtp.from = 'notifications@platform.test';

let server;
let sent;
let failNext = false;
const recorder = { sendMail: async (m) => { if (failNext) { failNext = false; throw new Error('SMTP down'); } sent.push(m); } };
let company;
let design;
let client;
let owner;
let assigner;
let tech;

before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await EmailLog.init();
});
after(async () => {
  setMailTransport(null);
  await mongoose.disconnect();
  await server?.stop();
});

const person = (fields) => User.create({ company: company._id, passwordHash: 'x', ...fields });
const to = () => sent.map((m) => m.to).sort();

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  await EmailLog.syncIndexes();
  sent = [];
  setMailTransport(recorder);
  company = await Company.create({ name: 'Acme Solar', email: 'info@acme.test', phone: '9800000000' });
  client = await Client.create({ company: company._id, name: 'Sunil Patil', email: 'sunil@client.test', phone: '9811111111' });
  design = await Design.create({ company: company._id, client: client._id, name: 'Patil bungalow – 8 kW', status: 'won' });
  owner = await person({ role: 'company', name: 'Owner', email: 'owner@acme.test' });
  const supervisors = await Role.create({ company: company._id, name: 'Supervisor', permissions: ['tasks:view', 'tasks:assign'] });
  assigner = await person({ role: 'agent', name: 'Asha Rao', email: 'asha@acme.test', staffRoles: [supervisors._id] });
  tech = await person({ role: 'agent', name: 'Farah Khan', email: 'farah@acme.test', permissions: ['tasks:view'] });
  await person({ role: 'client', client: client._id, name: 'Sunil Patil', email: 'SUNIL@client.test' }); // same address as the record: one email
  await person({ role: 'client', client: client._id, name: 'Meera Patil', email: 'meera@client.test' });
});

const base = () => ({ companyId: String(company._id), designId: String(design._id), clientId: String(client._id) });

test('a request reaches the client, the company’s owners and address, and staff who may assign — once', async () => {
  const payload = { ...base(), packageName: 'Premium AMC', requestedDate: new Date('2026-11-05'), note: 'Gate code <1234>', eventId: 'r1' };
  await amc.emailAmcRequested(payload);
  assert.deepEqual(to(), ['asha@acme.test', 'info@acme.test', 'meera@client.test', 'owner@acme.test', 'sunil@client.test']);
  const forClient = sent.find((m) => m.to === 'sunil@client.test');
  assert.match(forClient.subject, /received your AMC request — Premium AMC/);
  assert.deepEqual(forClient.from, { name: 'Acme Solar', address: 'notifications@platform.test' });
  assert.equal(forClient.replyTo, 'info@acme.test');
  assert.match(forClient.html, /\/portal\/maintenance/);
  const forCompany = sent.find((m) => m.to === 'owner@acme.test');
  assert.match(forCompany.html, /Gate code &lt;1234&gt;/); // escaped
  assert.match(forCompany.text, /Client: Sunil Patil · 9811111111/);

  await amc.emailAmcRequested(payload); // the same event again: nothing more
  assert.equal(sent.length, 5);
});

test('an assignment: the client and the assigned staff member hear, and the company — except whoever assigned it', async () => {
  await amc.emailAmcAssigned({ ...base(), projectId: 'p1', packageName: 'Premium AMC', requestedDate: new Date('2026-11-05'), assigneeId: String(tech._id), assigneeName: 'Farah Khan', actorId: String(owner._id), eventId: 'a1' });
  assert.deepEqual(to(), ['farah@acme.test', 'info@acme.test', 'meera@client.test', 'sunil@client.test']);
  assert.match(sent.find((m) => m.to === 'farah@acme.test').html, /\/agent\/projects\/p1/);
  assert.match(sent.find((m) => m.to === 'sunil@client.test').text, /Technician: Farah Khan/);
});

test('a visit due this week: the assigned staff member, or else everyone who may assign; the reminder job repeating sends nothing new', async () => {
  const due = { ...base(), projectId: 'p1', visitName: 'AMC 1', dueDate: new Date('2026-11-01') };
  await amc.emailAmcUpcoming({ ...due, eventId: 'v1' });
  assert.deepEqual(to(), ['asha@acme.test', 'info@acme.test', 'meera@client.test', 'owner@acme.test', 'sunil@client.test']);
  assert.match(sent.find((m) => m.to === 'asha@acme.test').subject, /Unassigned AMC visit/);
  await amc.emailAmcUpcoming({ ...due, eventId: 'v1' });
  assert.equal(sent.length, 5);

  sent = [];
  await amc.emailAmcUpcoming({ ...due, assigneeId: String(tech._id), eventId: 'v2' });
  assert.ok(sent.some((m) => m.to === 'farah@acme.test' && /Reminder: AMC 1/.test(m.subject)));
  assert.ok(!sent.some((m) => m.to === 'asha@acme.test'));
});

test('a completed visit: the client and the company; the staff member only when someone else closed it', async () => {
  const done = { ...base(), projectId: 'p1', visitName: 'AMC 1', completedByName: 'Farah Khan', completionNote: 'Panels cleaned', assigneeId: String(tech._id) };
  await amc.emailAmcCompleted({ ...done, actorId: String(tech._id), eventId: 'c1' });
  assert.deepEqual(to(), ['info@acme.test', 'meera@client.test', 'owner@acme.test', 'sunil@client.test']);
  assert.match(sent.find((m) => m.to === 'sunil@client.test').text, /Notes: Panels cleaned/);

  sent = [];
  await amc.emailAmcCompleted({ ...done, completedByName: 'Owner', actorId: String(owner._id), eventId: 'c2' });
  assert.ok(sent.some((m) => m.to === 'farah@acme.test'));
  assert.ok(!sent.some((m) => m.to === 'owner@acme.test'));
});

test('a failed send can be retried; nothing is sent while email isn’t set up', async () => {
  failNext = true;
  await amc.emailAmcCompleted({ ...base(), projectId: 'p1', visitName: 'AMC 1', actorId: String(owner._id), eventId: 'c3' });
  // three recipients (the client's two addresses and the company's own; the owner closed it, no one was assigned)
  assert.equal(sent.length, 2); // the first send failed
  await amc.emailAmcCompleted({ ...base(), projectId: 'p1', visitName: 'AMC 1', actorId: String(owner._id), eventId: 'c3' });
  assert.equal(sent.length, 3); // the failed one went out on the retry, the others weren't repeated

  setMailTransport(null);
  env.smtp.from = '';
  sent = [];
  await amc.emailAmcRequested({ ...base(), packageName: 'Premium AMC', requestedDate: new Date(), eventId: 'r9' });
  assert.equal(sent.length, 0);
  env.smtp.from = 'notifications@platform.test';
});

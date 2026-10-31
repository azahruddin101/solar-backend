// Subsidies against an in-memory MongoDB: opened from a proposal's Subsidy option, moved through the company's steps, and
// shown to the client (for their own shared proposals) without the company's private notes.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client, Company, Design, Subsidy } from '../src/models/index.js';
import { migrateSubsidies } from '../src/migrations/subsidy.migration.js';
import { createDesign, deleteDesign, updateDesign } from '../src/services/design.service.js';
import { getSubsidyOfDesign, listSubsidies, listMySubsidies, syncSubsidySteps, updateSubsidy, updateSubsidyStep, updateSubsidySteps } from '../src/services/subsidy.service.js';

let server;
let company;
let ravi;
const owner = { _id: new mongoose.Types.ObjectId(), name: 'Owner', role: 'company' };
const clientUser = (client) => ({ company: company._id, client: client._id });
const proposal = (fields = {}) => createDesign(company, owner, { client: ravi.id, type: 'quick', ...fields });

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
  await Subsidy.syncIndexes();
  company = await Company.create({ name: 'Acme Solar' });
  await updateSubsidySteps(company, { steps: [{ name: 'Documents' }, { name: 'Sanction', description: 'DISCOM approves the application' }] });
  ravi = await Client.create({ company: company._id, name: 'Ravi Kumar' });
});

test('a proposal created with the subsidy option gets a subsidy with the template steps', async () => {
  const onSubsidy = await proposal({ name: 'Rooftop 5 kW', subsidy: { enabled: true, central: 78000, state: 0 } });
  await proposal({ name: 'Cash option' });
  const subsidies = await listSubsidies(company);
  assert.equal(subsidies.length, 1);
  assert.equal(subsidies[0].design.name, 'Rooftop 5 kW');
  assert.equal(subsidies[0].client.name, 'Ravi Kumar');
  assert.deepEqual(subsidies[0].steps.map((s) => [s.name, s.status]), [['Documents', 'pending'], ['Sanction', 'pending']]);
  assert.equal((await getSubsidyOfDesign(company, onSubsidy.id)).id, subsidies[0].id);
});

test('one client can have a subsidy on each of several proposals', async () => {
  await proposal({ name: 'Option A', subsidy: { enabled: true, central: 78000, state: 0 } });
  await proposal({ name: 'Option B', subsidy: { enabled: true, central: 78000, state: 0 } });
  assert.equal((await listSubsidies(company)).length, 2);
});

test('turning the option on later opens the subsidy; off removes it only while untouched', async () => {
  const d = await proposal();
  await updateDesign(company, owner, d.id, { subsidy: { enabled: true, central: 78000, state: 0 } });
  assert.equal(await Subsidy.countDocuments(), 1);
  await updateDesign(company, owner, d.id, { subsidy: { enabled: false } });
  assert.equal(await Subsidy.countDocuments(), 0);

  await updateDesign(company, owner, d.id, { subsidy: { enabled: true, central: 78000, state: 0 } });
  const [subsidy] = await listSubsidies(company);
  await updateSubsidyStep(company, owner, subsidy.id, subsidy.steps[0].id, { status: 'done' });
  await assert.rejects(updateDesign(company, owner, d.id, { subsidy: { enabled: false } }), /already being processed/);
  assert.equal(await Subsidy.countDocuments(), 1);
  assert.equal((await Design.findById(d.id)).subsidy.enabled, true);
});

test('finishing every step completes the subsidy; reopening a step reopens it', async () => {
  await proposal({ subsidy: { enabled: true, central: 78000, state: 0 } });
  const [subsidy] = await listSubsidies(company);
  await updateSubsidyStep(company, owner, subsidy.id, subsidy.steps[0].id, { status: 'done' });
  let next = await updateSubsidyStep(company, owner, subsidy.id, subsidy.steps[1].id, { status: 'done', remark: 'Approved by the DISCOM' });
  assert.equal(next.status, 'completed');
  assert.equal(next.steps[1].remark, 'Approved by the DISCOM');
  next = await updateSubsidyStep(company, owner, subsidy.id, subsidy.steps[1].id, { status: 'in_progress' });
  assert.equal(next.status, 'in_progress');
  assert.equal(next.steps[1].completedAt, null);
});

test('steps added to the template later can be pulled into an open subsidy', async () => {
  await proposal({ subsidy: { enabled: true, central: 78000, state: 0 } });
  const [subsidy] = await listSubsidies(company);
  await assert.rejects(syncSubsidySteps(company, owner, subsidy.id), /already has every step/);
  await updateSubsidySteps(company, { steps: [{ name: 'Documents' }, { name: 'Sanction' }, { name: 'Disbursement' }] });
  const next = await syncSubsidySteps(company, owner, subsidy.id);
  assert.deepEqual(next.steps.map((s) => s.name), ['Documents', 'Sanction', 'Disbursement']);
});

test('the client sees the subsidies of their own proposals only, drafts included, without private notes', async () => {
  const asha = await Client.create({ company: company._id, name: 'Asha Rao' });
  const shared = await proposal({ name: 'Rooftop 5 kW', subsidy: { enabled: true, central: 78000, state: 0 } });
  await updateDesign(company, owner, shared.id, { status: 'proposed' });
  await proposal({ name: 'Still a draft', subsidy: { enabled: true, central: 78000, state: 0 } });
  await createDesign(company, owner, { client: asha.id, type: 'quick', subsidy: { enabled: true, central: 78000, state: 0 } });
  const subsidy = await getSubsidyOfDesign(company, shared.id);
  await updateSubsidy(company, owner, subsidy.id, { scheme: 'PM Surya Ghar', applicationNo: 'PMSG-77', notes: 'Roof papers pending — follow up' });

  const mine = await listMySubsidies(clientUser(ravi));
  assert.deepEqual(mine.map((l) => [l.proposal.name, l.proposal.shared]).sort(), [['Rooftop 5 kW', true], ['Still a draft', false]]);
  const sharedSubsidy = mine.find((l) => l.proposal.shared);
  assert.equal(sharedSubsidy.scheme, 'PM Surya Ghar');
  assert.equal(sharedSubsidy.centralAmount, 78000); // starts as the proposal's amount
  assert.equal(sharedSubsidy.notes, undefined);
  assert.equal(sharedSubsidy.logs, undefined);
  const hers = await listMySubsidies(clientUser(asha));
  assert.equal(hers.length, 1);
  assert.equal(hers[0].scheme, ''); // never Ravi's
});

test('the subsidy follows the proposal to another client, and goes when it is deleted', async () => {
  const asha = await Client.create({ company: company._id, name: 'Asha Rao' });
  const d = await proposal({ subsidy: { enabled: true, central: 78000, state: 0 } });
  await updateDesign(company, owner, d.id, { client: asha.id });
  assert.equal(String((await Subsidy.findOne()).client), asha.id);
  await deleteDesign(company, d.id);
  assert.equal(await Subsidy.countDocuments(), 0);
});

test('migration opens subsidy files for proposals already marked with a subsidy, and gives older companies the usual steps', async () => {
  const d = await Design.create({ company: company._id, client: ravi._id, name: 'Old proposal', subsidy: { enabled: true, central: 78000, state: 0 } });
  const older = await Company.create({ name: 'Older Solar' });
  await Company.collection.updateOne({ _id: older._id }, { $unset: { subsidySteps: '' } }); // a company from before subsidy steps existed
  await migrateSubsidies();
  await migrateSubsidies(); // safe to run again
  const subsidies = await Subsidy.find({ design: d._id });
  assert.equal(subsidies.length, 1);
  assert.equal(subsidies[0].steps.length, 2);
  assert.equal((await Company.findById(older._id)).subsidySteps.length, 7); // the usual PM Surya Ghar steps
  assert.equal((await Company.findById(company._id)).subsidySteps.length, 2); // a company's own steps are left alone
});

test('a new company starts with the usual subsidy steps, and a subsidy file starts with the proposal’s expected amounts', async () => {
  const fresh = await Company.create({ name: 'Fresh Solar' });
  assert.deepEqual(fresh.subsidySteps.map((x) => x.name).slice(0, 2), ['Documents collected', 'Registered on the portal']);
  assert.equal(fresh.subsidySteps.length, 7);
  const d = await proposal({ name: 'With subsidy', subsidy: { enabled: true, central: 78000, state: 15000 } });
  const file = await getSubsidyOfDesign(company, d.id);
  assert.deepEqual([file.centralAmount, file.stateAmount, file.receivedAmount], [78000, 15000, null]);
});

test('a proposal without a subsidy has no file, and a missing file is found by the dashboard preset', async () => {
  const d = await proposal({ name: 'No subsidy' });
  assert.equal(await getSubsidyOfDesign(company, d.id), null);
  const booked = await Design.create({ company: company._id, client: ravi._id, name: 'Booked, file missing', status: 'won', subsidy: { enabled: true, central: 1, state: 0 } });
  const { designShowMatch } = await import('../src/services/listPresets.js');
  const match = await designShowMatch(company, 'subsidy_missing');
  assert.deepEqual((await Design.find({ company: company._id, ...match })).map((x) => x.id), [booked.id]);
});

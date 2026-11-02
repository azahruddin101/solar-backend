// Proposals and installations (bug audit group 6):
//  - duplicating a proposal keeps everything that describes the quote (type, loan, subsidy, billing, site settings);
//  - an installation starts only from a booked proposal, and lists say which proposals have one (no page needs every
//    installation); any job can be found by name;
//  - restarting a deleted installation never reopens AMC bookings that were already carried out.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.S3_BUCKET = '';

const { Company, User, Client, Design, Project, Loan, Subsidy } = await import('../src/models/index.js');
const { duplicateDesign, listDesigns } = await import('../src/services/design.service.js');
const { startProject, listProjects } = await import('../src/services/project.service.js');
const { syncDesignAmcRequestsToProject } = await import('../src/services/amc.service.js');

let server;
before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
});
after(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
});

async function setup() {
  const company = await Company.create({ name: 'Co', installationSteps: [{ name: 'Survey' }], loanSteps: [{ name: 'Docs' }] });
  const owner = await User.create({ email: 'o@x.test', passwordHash: 'x', role: 'branch', company: company._id });
  const client = await Client.create({ company: company._id, name: 'Sharma' });
  return { company, owner, client };
}

test('duplicating a quick proposal keeps it a quick proposal with all its settings', async () => {
  const { company, owner, client } = await setup();
  const src = await Design.create({
    company: company._id, client: client._id, name: 'Sharma 5 kW', type: 'quick', status: 'won',
    data: { quote: { lines: [{ name: 'Panel', qty: 10, rate: 12000 }] } }, summary: { kwp: 5 },
    billingName: 'Sharma Traders', loanRequired: true, gridType: 'hybrid', projectType: 'commercial', roofType: 'tin_shed',
    cleaningFrequency: 4, cleaningCharge: 500, subsidy: { enabled: true, central: 78000, state: 10000 },
    clientResponse: { decision: 'accepted', respondedAt: new Date() },
  });
  const copy = await duplicateDesign(company, owner, src._id);
  const saved = await Design.findById(copy._id).lean();
  assert.equal(saved.type, 'quick');
  assert.equal(saved.status, 'draft');
  assert.equal(saved.clientResponse?.decision, undefined); // the client answered the original, not the copy
  assert.deepEqual([saved.billingName, saved.loanRequired, saved.gridType, saved.projectType, saved.roofType, saved.cleaningFrequency, saved.cleaningCharge],
    ['Sharma Traders', true, 'hybrid', 'commercial', 'tin_shed', 4, 500]);
  assert.deepEqual([saved.subsidy.enabled, saved.subsidy.central, saved.subsidy.state], [true, 78000, 10000]);
  assert.equal(saved.data.quote.lines[0].name, 'Panel');
  assert.notEqual(saved.shareToken, src.shareToken);
  // the copy gets its own loan and subsidy files, as a new proposal with these settings would
  assert.ok(await Loan.exists({ design: copy._id }));
  assert.ok(await Subsidy.exists({ design: copy._id }));
});

test('an installation starts only from a booked proposal; lists say which proposals have one', async () => {
  const { company, owner, client } = await setup();
  const [draft, won, other] = await Design.create([
    { company: company._id, client: client._id, name: 'Draft', status: 'draft' },
    { company: company._id, client: client._id, name: 'Won', status: 'won' },
    { company: company._id, client: client._id, name: 'Won too', status: 'won' },
  ]);
  await assert.rejects(startProject(company, owner, { design: String(draft._id) }), /booked \(won\) proposal/);
  const project = await startProject(company, owner, { design: String(won._id) });

  const list = await listDesigns(company, {});
  const byName = Object.fromEntries(list.items.map((d) => [d.name, d.installationId || null]));
  assert.equal(byName.Won, String(project._id ?? project.id));
  assert.equal(byName.Draft, null);
  // the "Start installation" picker: booked proposals with no installation yet
  assert.deepEqual((await listDesigns(company, { installable: true })).items.map((d) => d.name), ['Won too']);
  assert.ok(other);
});

test('any job can be found by its proposal or client name', async () => {
  const { company, owner, client } = await setup();
  const other = await Client.create({ company: company._id, name: 'Verma' });
  const [a, b] = await Design.create([
    { company: company._id, client: client._id, name: 'Rooftop A', status: 'won' },
    { company: company._id, client: other._id, name: 'Factory (shed)', status: 'won' },
  ]);
  await startProject(company, owner, { design: String(a._id) });
  await startProject(company, owner, { design: String(b._id) });
  const names = async (q) => (await listProjects(company, owner, { q })).items.map((p) => p.design?.name).sort();
  assert.deepEqual(await names('verma'), ['Factory (shed)']);
  assert.deepEqual(await names('rooftop'), ['Rooftop A']);
  assert.deepEqual(await names('(shed)'), ['Factory (shed)']); // typed characters are text, not a pattern
});

test('a restarted installation never reopens an AMC booking that was already carried out', async () => {
  const { company, client } = await setup();
  const design = await Design.create({
    company: company._id, client: client._id, name: 'D', status: 'won',
    amcRequests: [
      { packageName: 'Deep clean', requestedDate: new Date(), status: 'completed' },
      { packageName: 'Deep clean', requestedDate: new Date(), status: 'requested' },
    ],
  });
  const project = new Project({ company: company._id, design: design._id, client: client._id, steps: [] });
  syncDesignAmcRequestsToProject(design, project, { amcTemplates: [{ name: 'Deep clean', kind: 'optional', price: 1500 }] });
  assert.equal(project.amcVisits.length, 1); // only the open booking
  assert.equal(project.amcVisits[0].workflowStatus, 'requested');
});

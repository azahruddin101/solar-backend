// Shared settings ("masters") live on the Organization only. Every branch read sees them (models/companyMasters.plugin.js),
// whatever the query looks like, and the branch's own stale copy is never read nor written back. Saving the Settings
// page routes each field to where it lives. Invoice numbering stays per branch.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.S3_BUCKET = '';

const { Organization, Company, User, Client, Design, Project } = await import('../src/models/index.js');
const { saveCompanySettings, updateCompanyAsAdmin } = await import('../src/services/company.service.js');
const { ensureProjectAmc, spawnAmcVisitsForProject } = await import('../src/services/amc.service.js');
const { reserveInvoiceNo } = await import('../src/services/invoiceNumber.service.js').catch(() => ({}));
const { ROLES } = await import('../src/constants/index.js');

let server;
before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
});
after(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await Promise.all([Organization, Company, User, Client, Design, Project].map((M) => M.deleteMany({})));
});

const AMC = (name) => ({ name, daysAfterInstallation: 180, kind: 'mandatory' });

/** An organization whose settings differ from the stale copy left on its branch (as migrated companies have). */
async function setup({ hasBranches = false } = {}) {
  const org = await Organization.create({ name: 'Sunrise', hasBranches, tagline: 'Org tagline', tariff: 9, amcTemplates: [AMC('Yearly check')], features: { pdfBranding: false, excelImport: true } });
  const { insertedId } = await Company.collection.insertOne({
    organization: org._id, name: 'Pune', status: 'active', tagline: 'Stale branch tagline', tariff: 7,
    amcTemplates: [AMC('Old AMC')], features: { pdfBranding: true, excelImport: true }, invoiceNumbering: { prefix: 'PUN-', width: 4, next: 5 },
  });
  return { org, branchId: insertedId };
}

test('every way of reading a branch sees the organization’s settings, never the branch’s stale copy', async () => {
  const { branchId } = await setup();
  const doc = await Company.findById(branchId);
  assert.equal(doc.tagline, 'Org tagline');
  assert.equal(doc.tariff, 9);
  assert.deepEqual(doc.amcTemplates.map((t) => t.name), ['Yearly check']);
  assert.equal(doc.features.pdfBranding, false);

  const narrow = await Company.findById(branchId).select('amcTemplates').lean(); // as the portal and AMC code read it
  assert.deepEqual(narrow.amcTemplates.map((t) => t.name), ['Yearly check']);
  const list = await Company.find({ _id: branchId }).select('name tagline currency theme').lean();
  assert.equal(list[0].tagline, 'Org tagline');

  // branch-only fields stay the branch's own
  assert.equal(doc.invoiceNumbering.prefix, 'PUN-');
  // fields not asked for are not added, and migrations can still read the stored copy
  assert.equal((await Company.findById(branchId).select('name').lean()).tagline, undefined);
  assert.equal((await Company.findById(branchId).setOptions({ rawBranch: true }).lean()).tagline, 'Stale branch tagline');
});

test('saving a branch never writes the organization’s settings onto it', async () => {
  const { branchId } = await setup();
  const doc = await Company.findById(branchId);
  doc.phone = '9800000000';
  await doc.save();
  const raw = await Company.collection.findOne({ _id: branchId });
  assert.equal(raw.phone, '9800000000');
  assert.equal(raw.tagline, 'Stale branch tagline');
});

test('a staff member finishing the last step gets the organization’s AMC visits, and stale templates add none', async () => {
  const { branchId } = await setup();
  const client = await Client.create({ company: branchId, name: 'Ravi' });
  const design = await Design.create({ company: branchId, client: client._id, name: 'Ravi 5 kW', status: 'won' });
  const project = await Project.create({ company: branchId, design: design._id, client: client._id, status: 'completed', steps: [{ name: 'Wiring', status: 'done', completedAt: new Date() }] });

  // the staff path only knows the branch id (project.service.js passes { _id: user.company })
  await spawnAmcVisitsForProject(project, { _id: branchId });
  assert.deepEqual(project.amcVisits.map((v) => v.name), ['Yearly check']);
  await project.save();

  await ensureProjectAmc(project, { _id: branchId }); // opening the job again later
  assert.deepEqual((await Project.findById(project._id)).amcVisits.map((v) => v.name), ['Yearly check']);
});

test('company without branches: its owner’s Settings save the shared fields on the organization and the numbering on the branch', async () => {
  const { org, branchId } = await setup();
  const owner = await User.create({ email: 'o@x.in', passwordHash: 'x', role: ROLES.BRANCH, company: branchId, organization: org._id });
  const company = await Company.findById(branchId);
  await saveCompanySettings({ company, organization: org, user: owner }, {
    tagline: 'New tagline', tariff: 10, agentRoles: ['Installer'], phone: '9811111111', invoiceNumbering: { prefix: 'SUN-', width: 5, next: '00005' },
  });

  const reread = await Company.findById(branchId);
  assert.equal(reread.tagline, 'New tagline');
  assert.equal(reread.tariff, 10);
  assert.deepEqual([...reread.agentRoles], ['Installer']);
  assert.equal(reread.phone, '9811111111');
  assert.equal(reread.invoiceNumbering.prefix, 'SUN-');
  assert.equal((await Organization.findById(org._id)).tagline, 'New tagline');
  assert.equal(company.tagline, 'New tagline'); // the response shows what was saved
});

test('company with branches: a branch owner can save their own details but not change shared branding', async () => {
  const { org, branchId } = await setup({ hasBranches: true });
  const owner = await User.create({ email: 'b@x.in', passwordHash: 'x', role: ROLES.BRANCH, company: branchId, organization: org._id });
  const company = await Company.findById(branchId);

  // the whole form comes back, shared fields unchanged: allowed
  await saveCompanySettings({ company, organization: org, user: owner }, { tagline: 'Org tagline', tariff: 9, phone: '9822222222' });
  assert.equal((await Company.findById(branchId)).phone, '9822222222');

  await assert.rejects(saveCompanySettings({ company, organization: org, user: owner }, { tagline: 'Mine' }), /set by your company admin/);
  assert.equal((await Organization.findById(org._id)).tagline, 'Org tagline');

  const admin = await User.create({ email: 'a@x.in', passwordHash: 'x', role: ROLES.COMPANY, company: branchId, organization: org._id });
  await saveCompanySettings({ company, organization: org, user: admin }, { tagline: 'Admin tagline' });
  assert.equal((await Company.findById(branchId)).tagline, 'Admin tagline');
});

test('feature switches set by the platform admin take effect', async () => {
  const { branchId } = await setup();
  await updateCompanyAsAdmin(String(branchId), { features: { pdfBranding: true, excelImport: false } });
  const reread = await Company.findById(branchId);
  assert.equal(reread.features.pdfBranding, true);
  assert.equal(reread.features.excelImport, false);
});

test('each branch keeps its own invoice series', { skip: !reserveInvoiceNo && 'no reserveInvoiceNo export' }, async () => {
  const { org, branchId } = await setup({ hasBranches: true });
  const { insertedId: other } = await Company.collection.insertOne({ organization: org._id, name: 'Mumbai', status: 'active', invoiceNumbering: { prefix: 'MUM-', width: 4, next: 1 } });
  const pune = await reserveInvoiceNo(await Company.findById(branchId));
  const mumbai = await reserveInvoiceNo(await Company.findById(other));
  assert.equal(pune, 'PUN-0005');
  assert.equal(mumbai, 'MUM-0001');
});

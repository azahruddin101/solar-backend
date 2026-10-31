// Deleting a company removes everything that belongs to it and nothing of another company. The first test walks every
// registered model, so a new collection with a `company` field fails here until it is added to services/companyData.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// never touch a real bucket or upload folder, whatever backend/.env says
process.env.S3_BUCKET = '';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'company-delete-'));

const models = await import('../src/models/index.js');
// register every model file, including any the index does not export, so none can hide from the walk below
const modelsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/models');
for (const file of fs.readdirSync(modelsDir).filter((f) => f.endsWith('.model.js'))) await import(path.join(modelsDir, file));
const { COMPANY_SCOPED_MODELS, REMOVED_ELSEWHERE } = await import('../src/services/companyData.js');
const { deleteCompany } = await import('../src/services/company.service.js');

let server;
before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init())); // indexes are built before rows go in, so the run never races them
});
after(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

/** A value for every field of the model's unique indexes, so seeded rows never clash (token, number, design, session id...). */
function uniqueValues(M, tag) {
  const fields = new Set();
  for (const [keys, options] of M.schema.indexes()) if (options?.unique) Object.keys(keys).forEach((k) => fields.add(k));
  M.schema.eachPath((name, type) => { if (type.options?.unique) fields.add(name); });
  fields.delete('company');
  const out = {};
  for (const f of fields) out[f] = M.schema.path(f)?.instance === 'ObjectId' ? new mongoose.Types.ObjectId() : `${tag}-${f}`;
  return out;
}

const ownedByCompany = (M) => Boolean(M.schema.path('company'));

test('every model that belongs to a company is deleted with it', () => {
  const covered = new Set([...COMPANY_SCOPED_MODELS, ...REMOVED_ELSEWHERE.keys()]);
  const forgotten = mongoose.modelNames().map((n) => mongoose.model(n)).filter((M) => ownedByCompany(M) && !covered.has(M)).map((M) => M.modelName);
  assert.deepEqual(forgotten, [], `these models have a company field but deleteCompany does not remove them: add them to services/companyData.js`);
  // the list holds real models only, once each
  assert.equal(new Set(COMPANY_SCOPED_MODELS).size, COMPANY_SCOPED_MODELS.length);
  assert.ok(COMPANY_SCOPED_MODELS.length >= 35, `only ${COMPANY_SCOPED_MODELS.length} models listed`);
});

test('deleting a company removes its data in every collection and leaves another company untouched', async () => {
  const { Company, Notification, AuthSession, Plan, User } = models;
  const mine = await Company.create({ name: 'Doomed Solar' });
  const other = await Company.create({ name: 'Other Solar' });
  const ownerOf = async (c) => User.collection.insertOne({ email: `${c.name.replace(/\W/g, '')}@x.test`, role: 'company', company: c._id, name: 'Owner' });
  const mineOwner = await ownerOf(mine);
  await ownerOf(other);

  // one raw row per listed model for each company (raw: these rows only need to exist)
  const seeded = [];
  for (const M of COMPANY_SCOPED_MODELS) {
    if (M === User) continue;
    for (const c of [mine, other]) await M.collection.insertOne({ company: c._id, ...uniqueValues(M, `${M.modelName}-${c.id}`) });
    seeded.push(M);
  }
  // rows written without a company, found through the company's users
  await Notification.collection.insertOne({ user: mineOwner.insertedId, title: 'no company on this one' });
  await AuthSession.collection.insertOne({ user: mineOwner.insertedId });
  await Plan.collection.insertMany([{ name: 'Custom for mine', code: 'custom-mine', forCompany: mine._id }, { name: 'Custom for other', code: 'custom-other', forCompany: other._id }, { name: 'Basic', code: 'basic-test' }]);

  await deleteCompany(mine.id);

  for (const M of COMPANY_SCOPED_MODELS) {
    assert.equal(await M.collection.countDocuments({ company: mine._id }), 0, `${M.modelName} still has the deleted company's data`);
    if (M !== User) assert.equal(await M.collection.countDocuments({ company: other._id }), 1, `${M.modelName} lost the other company's data`);
  }
  assert.equal(await Notification.collection.countDocuments({ user: mineOwner.insertedId }), 0);
  assert.equal(await AuthSession.collection.countDocuments({ user: mineOwner.insertedId }), 0);
  assert.deepEqual((await Plan.collection.find().toArray()).map((p) => p.name).sort(), ['Basic', 'Custom for other']);
  assert.equal(await Company.countDocuments({ _id: mine._id }), 0);
  assert.equal(await Company.countDocuments({ _id: other._id }), 1);
});

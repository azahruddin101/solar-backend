// Documents kept with a loan step: added after the upload middleware stored them, removed with their stored file, kept
// from the client portal, and opened only by the company's own staff who may see loans. Files go to a temporary folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loan-docs-'));
process.env.UPLOAD_DIR = uploadDir;
process.env.S3_BUCKET = '';
const { Client, Company, Loan } = await import('../src/models/index.js');
const { createDesign, deleteDesign, updateDesign } = await import('../src/services/design.service.js');
const { MAX_STEP_DOCUMENTS, addStepDocument, getLoan, listMyLoans, removeStepDocument, renameStepDocument, updateLoanSteps } = await import('../src/services/loan.service.js');
const { assertCanOpen, isProtected } = await import('../src/services/fileAccess.service.js');

let server;
let company;
let ravi;
let design;
let loan;
const owner = { _id: new mongoose.Types.ObjectId(), name: 'Owner', role: 'company' };

before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
});

after(async () => {
  await mongoose.disconnect();
  await server?.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  await Loan.syncIndexes();
  company = await Company.create({ name: 'Acme Solar' });
  await updateLoanSteps(company, { steps: [{ name: 'Documents' }, { name: 'Sanction' }] });
  ravi = await Client.create({ company: company._id, name: 'Ravi Kumar' });
  design = await createDesign(company, owner, { client: ravi.id, type: 'quick', name: 'Rooftop 5 kW', loanRequired: true });
  loan = await Loan.findOne({ design: design.id });
});

/** What uploadLoanDocument hands the route: the file is already in storage. */
function stored(originalname = 'Bank statement.xlsx') {
  const ext = path.extname(originalname).slice(1).toLowerCase() || 'pdf';
  const filename = `${company.id}-loandoc-${loan.id}-${Math.random().toString(16).slice(2)}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, filename), 'test');
  return { filename, originalname, size: 4 };
}
const exists = (url) => fs.existsSync(path.join(uploadDir, path.basename(url)));
const stepId = (i = 0) => loan.steps[i].id;

describe('loan step documents', () => {
  test('adds a document to the step and logs it; removing it deletes the stored file', async () => {
    const saved = await addStepDocument(company, owner, loan.id, stepId(), stored('Aadhaar.pdf'));
    const [doc] = saved.steps[0].documents;
    assert.equal(doc.name, 'Aadhaar.pdf');
    assert.equal(doc.byName, 'Owner');
    assert.ok(doc.id && exists(doc.url));
    assert.equal(saved.steps[1].documents.length, 0);
    assert.equal(saved.logs.at(-1).action, 'document_added');

    const after = await removeStepDocument(company, owner, loan.id, stepId(), doc.id);
    assert.equal(after.steps[0].documents.length, 0);
    assert.equal(after.logs.at(-1).action, 'document_removed');
    assert.equal(exists(doc.url), false);
  });

  test('renames a document, keeping the file’s extension, and logs it', async () => {
    const [doc] = (await addStepDocument(company, owner, loan.id, stepId(), stored('scan_001.pdf'))).steps[0].documents;
    const renamed = await renameStepDocument(company, owner, loan.id, stepId(), doc.id, '  Aadhaar card ');
    assert.equal(renamed.steps[0].documents[0].name, 'Aadhaar card.pdf');
    assert.equal(renamed.steps[0].documents[0].url, doc.url);
    assert.equal(renamed.logs.at(-1).action, 'document_renamed');
    assert.equal(renamed.logs.at(-1).message, 'scan_001.pdf → Aadhaar card.pdf');

    const same = await renameStepDocument(company, owner, loan.id, stepId(), doc.id, 'Aadhaar card.PDF');
    assert.equal(same.steps[0].documents[0].name, 'Aadhaar card.PDF');
    const logs = same.logs.length;
    assert.equal((await renameStepDocument(company, owner, loan.id, stepId(), doc.id, 'Aadhaar card.PDF')).logs.length, logs); // unchanged: no log
    await assert.rejects(renameStepDocument(company, owner, loan.id, stepId(1), doc.id, 'x'), /not found/i);
  });

  test(`keeps at most ${MAX_STEP_DOCUMENTS} per step; a refused upload leaves no file behind`, async () => {
    for (let i = 0; i < MAX_STEP_DOCUMENTS; i++) await addStepDocument(company, owner, loan.id, stepId(), stored());
    const extra = stored();
    await assert.rejects(addStepDocument(company, owner, loan.id, stepId(), extra), /up to 20/);
    assert.equal(exists(extra.filename), false);
  });

  test('another company’s loan or an unknown step is not found, and the upload is removed', async () => {
    const other = await Company.create({ name: 'Other' });
    const a = stored();
    await assert.rejects(addStepDocument(other, owner, loan.id, stepId(), a), /not found/i);
    assert.equal(exists(a.filename), false);
    const b = stored();
    await assert.rejects(addStepDocument(company, owner, loan.id, new mongoose.Types.ObjectId().toString(), b), /not found/i);
    assert.equal(exists(b.filename), false);
  });

  test('the client portal never lists the documents', async () => {
    await addStepDocument(company, owner, loan.id, stepId(), stored());
    const [mine] = await listMyLoans({ company: company._id, client: ravi._id });
    assert.ok(mine.steps.every((s) => s.documents === undefined));
    assert.equal((await getLoan(company, loan.id)).steps[0].documents.length, 1);
  });

  test('a loan with documents can’t be dropped by turning the loan option off; deleting the proposal deletes the files', async () => {
    const { url } = (await addStepDocument(company, owner, loan.id, stepId(), stored())).steps[0].documents[0];
    await assert.rejects(updateDesign(company, owner, design.id, { loanRequired: false }), /already being processed/);
    await deleteDesign(company, design.id);
    assert.equal(await Loan.countDocuments(), 0);
    assert.equal(exists(url), false);
  });

  test('the files are protected: staff of the same company who see loans may open them', async () => {
    const name = `${company.id}-loandoc-${loan.id}-abc.xlsx`;
    assert.ok(isProtected(name));
    const staff = (permissions) => ({ role: 'agent', company: company._id, permissions });
    await assertCanOpen({ role: 'company', company: company._id }, name);
    await assertCanOpen(staff(['loans:view']), name);
    await assert.rejects(assertCanOpen(staff(['clients:view']), name));
    await assert.rejects(assertCanOpen({ role: 'company', company: new mongoose.Types.ObjectId() }, name));
    await assert.rejects(assertCanOpen({ role: 'client', company: company._id, client: ravi._id }, name));
  });
});

// PDFs kept with a product: added after the upload middleware stored them, removed with their stored file, and
// opened only by the company's own staff who may see products. Files go to a temporary local folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-docs-'));
process.env.UPLOAD_DIR = uploadDir;
process.env.S3_BUCKET = '';
const { Category, Company, Product } = await import('../src/models/index.js');
const { categoryService, MAX_PRODUCT_DOCUMENTS, productService } = await import('../src/services/catalog.service.js');
const { assertCanOpen, isProtected } = await import('../src/services/fileAccess.service.js');

let replSet;
let company;
let category;
let product;

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
});

after(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  company = await Company.create({ name: 'Acme Solar' });
  category = await Category.create({ company: company._id, name: 'Inverters' });
  product = await Product.create({ company: company._id, category: category._id, name: 'Hybrid inverter 5 kW' });
});

/** What uploadProductDocument hands the controller: the file is already in storage. */
function stored(originalname = 'Datasheet.pdf') {
  const filename = `${company.id}-proddoc-${product.id}-${Math.random().toString(16).slice(2)}.pdf`;
  fs.writeFileSync(path.join(uploadDir, filename), '%PDF-1.4 test');
  return { filename, originalname, size: 13 };
}
const exists = (url) => fs.existsSync(path.join(uploadDir, path.basename(url)));

describe('product documents', () => {
  test('adds a PDF named after the file, and removing it deletes the stored file', async () => {
    const saved = await productService.addDocument(company, product.id, stored('Inverter datasheet.PDF'));
    assert.equal(saved.documents.length, 1);
    const [doc] = saved.documents;
    assert.equal(doc.name, 'Inverter datasheet');
    assert.equal(doc.size, 13);
    assert.ok(doc.id && exists(doc.url));

    const after = await productService.removeDocument(company, product.id, doc.id);
    assert.equal(after.documents.length, 0);
    assert.equal(exists(doc.url), false);
  });

  test(`keeps at most ${MAX_PRODUCT_DOCUMENTS}; a refused upload leaves no file behind`, async () => {
    for (let i = 0; i < MAX_PRODUCT_DOCUMENTS; i++) await productService.addDocument(company, product.id, stored());
    const extra = stored();
    await assert.rejects(productService.addDocument(company, product.id, extra), /up to 10/);
    assert.equal(fs.existsSync(path.join(uploadDir, extra.filename)), false);
  });

  test('another company’s product is not found, and its upload is removed', async () => {
    const other = await Company.create({ name: 'Other' });
    const file = stored();
    await assert.rejects(productService.addDocument(other, product.id, file), /not found/i);
    assert.equal(fs.existsSync(path.join(uploadDir, file.filename)), false);
  });

  test('ordinary product edits leave the documents alone', async () => {
    await productService.addDocument(company, product.id, stored());
    const saved = await productService.update(company, product.id, { name: 'Hybrid inverter 6 kW', documents: [] });
    assert.equal(saved.documents.length, 1);
  });

  test('deleting the product or its category deletes the files', async () => {
    const one = (await productService.addDocument(company, product.id, stored())).documents[0];
    await productService.remove(company, product.id);
    assert.equal(exists(one.url), false);

    product = await Product.create({ company: company._id, category: category._id, name: 'Battery' });
    const two = (await productService.addDocument(company, product.id, stored())).documents[0];
    await categoryService.remove(company, category.id);
    assert.equal(exists(two.url), false);
  });

  test('the files are protected: staff of the same company who see products may open them', async () => {
    const name = `${company.id}-proddoc-${product.id}-abc.pdf`;
    assert.ok(isProtected(name));
    const staff = (permissions) => ({ role: 'agent', company: company._id, permissions });
    await assertCanOpen({ role: 'company', company: company._id }, name);
    await assertCanOpen(staff(['inventory:view']), name);
    await assert.rejects(assertCanOpen(staff(['clients:view']), name));
    await assert.rejects(assertCanOpen({ role: 'company', company: new mongoose.Types.ObjectId() }, name));
    await assert.rejects(assertCanOpen({ role: 'client', company: company._id }, name));
  });
});

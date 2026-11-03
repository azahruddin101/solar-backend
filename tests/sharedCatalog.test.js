// The catalog (parent categories, categories, products) belongs to the organization and is shared by its branches;
// stock (batches, serial units) and suppliers stay per branch. Only the company admin changes a shared catalog.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const { Batch, Category, Company, Organization, ParentCategory, Product, Supplier } = await import('../src/models/index.js');
const { categoryService, productService } = await import('../src/services/catalog.service.js');
const { receiveStock, stockSummary } = await import('../src/services/stock.service.js');
const { catalogEditorOnly } = await import('../src/middlewares/auth.middleware.js');
const { migrateSharedCatalog } = await import('../src/migrations/sharedCatalog.migration.js');
const { enforceTenantCatalogIsolation } = await import('../src/migrations/tenantCatalog.migration.js');
const { deleteCompanyData } = await import('../src/services/companyData.js');

let replSet;
let org;
let pune;
let mumbai;

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
});
after(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  org = await Organization.create({ name: 'Sunrise', hasBranches: true });
  pune = await Company.create({ name: 'Pune', organization: org._id });
  mumbai = await Company.create({ name: 'Mumbai', organization: org._id });
});

const supplierOf = (branch) => Supplier.create({ company: branch._id, name: `${branch.name} traders` });
const gate = (user, organization) => {
  try {
    catalogEditorOnly({ user, organization }, {}, () => {});
    return true;
  } catch {
    return false;
  }
};

test('a product made in one branch is in every branch’s catalog; stock stays per branch', async () => {
  const category = await categoryService.create(pune, { name: 'Inverters' });
  const product = await productService.create(pune, { category: category.id, name: 'Hybrid 5 kW' });
  assert.equal(String((await Product.findById(product.id)).organization), org.id);

  assert.deepEqual((await productService.list(mumbai)).map((p) => p.name), ['Hybrid 5 kW']);
  assert.deepEqual((await categoryService.list(mumbai)).map((c) => [c.name, c.products]), [['Inverters', 1]]);

  const base = { basePrice: 100, wholesalePrice: 100, retailPrice: 120 };
  await receiveStock(pune, product.id, { ...base, supplier: (await supplierOf(pune)).id, qtyReceived: 5 });
  await receiveStock(mumbai, product.id, { ...base, supplier: (await supplierOf(mumbai)).id, qtyReceived: 2 });
  assert.equal((await stockSummary(pune._id)).get(product.id).stock, 5);
  assert.equal((await stockSummary(mumbai._id)).get(product.id).stock, 2);
  assert.equal((await productService.get(mumbai, product.id)).stock, 2);

  // a branch can't take another branch's supplier
  await assert.rejects(receiveStock(mumbai, product.id, { ...base, supplier: (await Supplier.findOne({ company: pune._id })).id, qtyReceived: 1 }), /not found/i);
});

test('another organization never sees the catalog', async () => {
  const other = await Company.create({ name: 'Elsewhere', organization: (await Organization.create({ name: 'Other', hasBranches: false }))._id });
  const category = await categoryService.create(pune, { name: 'Inverters' });
  const product = await productService.create(pune, { category: category.id, name: 'Hybrid 5 kW' });
  assert.equal((await productService.list(other)).length, 0);
  await assert.rejects(productService.get(other, product.id), /not found/i);
  await assert.rejects(receiveStock(other, product.id, { supplier: (await supplierOf(other)).id, qtyReceived: 1, basePrice: 1, wholesalePrice: 1, retailPrice: 1 }), /not found/i);
});

test('with branches only the company admin changes the catalog; without branches the owner does', async () => {
  assert.equal(gate({ role: 'company' }, org), true);
  assert.equal(gate({ role: 'branch' }, org), false);
  assert.equal(gate({ role: 'agent' }, org), false);
  const solo = { hasBranches: false };
  assert.equal(gate({ role: 'branch' }, solo), true);
  assert.equal(gate({ role: 'agent' }, solo), true); // still needs its inventory permission (checked before)
});

test('migration: branch catalogs become the organization’s, same-named categories merge, products are kept', async () => {
  const raw = (M, doc) => M.collection.insertOne({ createdAt: new Date(), ...doc });
  const pParent = (await raw(ParentCategory, { company: pune._id, name: 'Electricals', createdAt: new Date(1) })).insertedId;
  const mParent = (await raw(ParentCategory, { company: mumbai._id, name: 'electricals', createdAt: new Date(2) })).insertedId;
  const pCat = (await raw(Category, { company: pune._id, name: 'Inverters', type: 'general', parent: pParent, attributes: [{ key: 'kw', label: 'kW' }], createdAt: new Date(1) })).insertedId;
  const mCat = (await raw(Category, { company: mumbai._id, name: 'Inverters', type: 'general', parent: mParent, attributes: [{ key: 'phase', label: 'Phase' }], createdAt: new Date(2) })).insertedId;
  const mPanels = (await raw(Category, { company: mumbai._id, name: 'inverters ', type: 'panels', createdAt: new Date(3) })).insertedId;
  const mProduct = (await raw(Product, { company: mumbai._id, category: mCat, name: 'Hybrid 5 kW', type: 'general' })).insertedId;
  await raw(Product, { company: pune._id, category: pCat, name: 'Hybrid 5 kW', type: 'general' });
  const supplier = await Supplier.create({ company: mumbai._id, name: 'M', categories: [mCat] });
  await Batch.create({ company: mumbai._id, product: mProduct, supplier: supplier._id, qtyReceived: 3, qtyRemaining: 3, basePrice: 1, wholesalePrice: 1, retailPrice: 1 });

  await migrateSharedCatalog();
  await migrateSharedCatalog(); // idempotent
  await enforceTenantCatalogIsolation(); // must not delete products filed under another branch's category

  assert.equal(await ParentCategory.countDocuments({ organization: org._id }), 1);
  const cats = await Category.find({ organization: org._id }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(cats.map((c) => c.name), ['Inverters', 'Inverters (Mumbai)']);
  assert.deepEqual(cats[0].attributes.map((a) => a.key), ['kw', 'phase']);
  assert.equal(String(cats[1]._id), String(mPanels));
  assert.equal(await Product.countDocuments({ organization: org._id, category: pCat }), 2);
  assert.deepEqual((await Supplier.findById(supplier._id)).categories.map(String), [String(pCat)]);
  assert.equal((await stockSummary(mumbai._id)).get(String(mProduct)).stock, 3);
});

test('deleting one branch keeps the shared catalog; the last branch takes it along', async () => {
  const category = await categoryService.create(mumbai, { name: 'Inverters' });
  await productService.create(mumbai, { category: category.id, name: 'Hybrid 5 kW' });
  await deleteCompanyData(mumbai._id);
  await Company.deleteOne({ _id: mumbai._id });
  assert.equal((await productService.list(pune)).length, 1);
  assert.equal(String((await Product.findOne()).company), pune.id);

  await deleteCompanyData(pune._id);
  assert.equal(await Product.countDocuments(), 0);
  assert.equal(await Category.countDocuments(), 0);
});

test('each branch builds its own packages from the shared catalog', async () => {
  const { packageService } = await import('../src/services/package.service.js');
  const category = await categoryService.create(pune, { name: 'Solar panels', type: 'panels' });
  const utl = await productService.create(pune, { category: category.id, brand: 'UTL', model: 'U540', watts: 540, length: 2.2, width: 1.1 });
  const waaree = await productService.create(pune, { category: category.id, brand: 'Waaree', model: 'W550', watts: 550, length: 2.2, width: 1.1 });

  await packageService.create(pune, { name: 'Rural 3 kW', price: 150000, items: [{ productId: utl.id, qty: 6 }] });
  await packageService.create(mumbai, { name: 'Premium 3 kW', price: 210000, items: [{ productId: waaree.id, qty: 6 }] });

  const [rural] = await packageService.list(pune);
  const [premium] = await packageService.list(mumbai);
  assert.equal((await packageService.list(pune)).length, 1); // a branch sees only its own packages
  assert.equal(rural.name, 'Rural 3 kW');
  assert.equal(premium.name, 'Premium 3 kW');
  assert.equal(premium.items.length, 1); // a product made in another branch still shows in the package
  assert.match(JSON.stringify(premium.items[0]), /Waaree/);
});

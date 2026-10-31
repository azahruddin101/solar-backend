// The inventory seed on top of the showcase catalog: every scenario it promises exists, re-running adds nothing, and
// the reset takes it all away again. Against an in-memory replica set (stock receipts run in transactions).
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Batch, Category, Company, Product, SerialUnit, Supplier } from '../src/models/index.js';
import { INVENTORY_PRODUCTS, INVENTORY_SUPPLIERS } from '../src/seeders/data/inventory.js';
import { resetInventory, seedInventory } from '../src/seeders/inventory.seeder.js';
import { seedShowcaseCatalog } from '../src/seeders/showcaseCatalog.js';
import { listBatches, stockSummary } from '../src/services/stock.service.js';

let replSet;
let company;
const quiet = { log: () => {} };
const bySku = (sku) => Product.findOne({ company: company._id, sku }).lean();

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
  await Promise.all([Batch, SerialUnit, Company].map((M) => M.init()));
});
after(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  await Promise.all([Batch, SerialUnit].map((M) => M.syncIndexes()));
  company = await Company.create({ name: 'Acme Solar' });
  await seedShowcaseCatalog(company._id);
});

test('seeds suppliers, a new category, every product with its receipts, and second sources for the showcase products', async () => {
  const before = { products: await Product.countDocuments({ company: company._id }), batches: await Batch.countDocuments({ company: company._id }), units: await SerialUnit.countDocuments({ company: company._id }), suppliers: await Supplier.countDocuments({ company: company._id }) };
  const s = await seedInventory(company._id, quiet);
  assert.equal(s.suppliers, INVENTORY_SUPPLIERS.length);
  assert.equal(s.categories, 1); // Accessories & Consumables
  assert.equal(s.products, INVENTORY_PRODUCTS.length);
  const ownBatches = INVENTORY_PRODUCTS.reduce((a, p) => a + p.batches.length, 0);
  assert.equal(s.batches, ownBatches + 2 * before.products); // two extra receipts per showcase product
  assert.equal(await Product.countDocuments({ company: company._id }), before.products + INVENTORY_PRODUCTS.length);
  assert.equal(await Batch.countDocuments({ company: company._id }), before.batches + s.batches);
  assert.equal(await SerialUnit.countDocuments({ company: company._id }), before.units + s.units);
  assert.equal(await Supplier.countDocuments({ company: company._id }), before.suppliers + INVENTORY_SUPPLIERS.length);

  // the unregistered dealer has no GSTIN; the Gujarat one keeps its uppercase inter-state GSTIN and its categories
  const kalyani = await Supplier.findOne({ company: company._id, name: /Kalyani/ }).lean();
  assert.equal(kalyani.gstNumber, '');
  const gujarat = await Supplier.findOne({ company: company._id, name: /Gujarat/ }).lean();
  assert.equal(gujarat.gstNumber, '24AAFCG2911R1Z2');
  assert.equal(gujarat.categories.length, 3);
  // the new category carries a boolean attribute and its products validated against it
  const acc = await Category.findOne({ company: company._id, name: 'Accessories & Consumables' }).lean();
  assert.ok(acc.attributes.some((a) => a.dataType === 'boolean'));
  const mc4 = await bySku('ACC-ST-MC4');
  assert.equal(mc4.attributes.outdoorRated, true);
  assert.equal(mc4.attributes.packSize, 1);
  assert.equal(String(mc4.category), String(acc._id));
});

test('the scenarios: FIFO across suppliers and prices, consumed batches, low and zero stock, big serial lots, GST rates', async () => {
  await seedInventory(company._id, quiet);
  const summary = await stockSummary(company._id);
  const stock = async (sku) => summary.get(String((await bySku(sku))._id)) || { stock: 0 };

  // 3 batches, 3 suppliers, 3 prices; manufacture date / year / neither
  const waaree = await bySku('PNL-WA-545B');
  const wb = await Batch.find({ product: waaree._id }).sort({ receivedDate: 1 }).lean();
  assert.equal(wb.length, 3);
  assert.equal(new Set(wb.map((b) => String(b.supplier))).size, 3);
  assert.deepEqual(wb.map((b) => b.retailPrice), [14400, 14100, 14900]);
  assert.ok(wb[0].mfgDate && !wb[0].mfgYear && !wb[1].mfgDate && wb[1].mfgYear === 2026 && !wb[2].mfgDate && !wb[2].mfgYear);
  assert.equal((await stock('PNL-WA-545B')).stock, 120);
  assert.equal(await SerialUnit.countDocuments({ product: waaree._id, status: 'inStock' }), 120);

  assert.equal((await stock('PNL-AD-590')).stock, 1); // exactly one
  assert.equal((await stock('PNL-RN-550')).stock, 0); // never received
  assert.equal(await Batch.countDocuments({ product: (await bySku('PNL-RN-550'))._id }), 0);

  const goldi = await bySku('PNL-GD-575');
  assert.equal(await SerialUnit.countDocuments({ product: goldi._id }), 150);
  assert.ok(await SerialUnit.exists({ product: goldi._id, serialNo: 'GS/575/26/0150' }));

  // same price twice: one line, no split
  const growatt = await Batch.find({ product: (await bySku('INV-GW-6K3'))._id }).lean();
  assert.equal(new Set(growatt.map((b) => b.retailPrice)).size, 1);
  assert.equal(new Set(growatt.map((b) => String(b.supplier))).size, 2);

  // low stock
  const lum = await bySku('INV-LU-3KH');
  assert.equal((await stock('INV-LU-3KH')).stock, 2);
  assert.ok(2 <= lum.reorderLevel);
  // not serialized although the category is
  assert.equal((await bySku('INV-GW-WIFI')).isSerialized, false);

  // partly consumed older batch: 200 left of 500, then 500 → 700 on hand, FIFO starts on the older one
  const polycab = await bySku('CAB-PC-AC10');
  const pb = await Batch.find({ product: polycab._id }).sort({ receivedDate: 1 }).lean();
  assert.deepEqual(pb.map((b) => [b.qtyReceived, b.qtyRemaining]), [[500, 200], [500, 500]]);
  assert.equal((await stock('CAB-PC-AC10')).stock, 700);
  assert.equal((await stock('CAB-PC-AC10')).price, 165); // the oldest batch with stock prices the next sale
  // fully consumed first batch is hidden from the in-stock list
  const finolex = await bySku('CAB-FX-E6');
  assert.equal((await listBatches(company, finolex._id, { inStock: true })).length, 1);
  assert.equal((await listBatches(company, finolex._id)).length, 2);
  // out of stock because everything was consumed; the newest batch still prices it
  assert.equal((await stock('CAB-RR-15')).stock, 0);
  assert.equal((await stock('CAB-RR-15')).price, 1500);
  // huge quantity, no purchase price
  const flex = await Batch.findOne({ product: (await bySku('CAB-HV-F25'))._id }).lean();
  assert.equal(flex.qtyRemaining, 50000);
  assert.equal(flex.purchasePrice, 0);
  // GST rates and units
  assert.equal((await bySku('BAT-AM-200')).gstPercent, 28);
  assert.equal((await bySku('ACC-AS-BFC')).gstPercent, 5);
  assert.equal((await bySku('ACC-AS-BFC')).unit, 'Kg');
  assert.equal((await bySku('ACC-DOC-WB')).gstPercent, 0);
  const kit = await Product.findOne({ company: company._id, name: /Panel cleaning kit/ }).lean();
  assert.equal(kit.sku, '');
  assert.equal(kit.gstPercent, 12);
  // a pole with its shape, a panel with its size
  assert.equal((await bySku('POLE-GIRT8040')).shape, 'square');
  assert.equal(waaree.watts, 545);
  // the company learnt the new units
  const co = await Company.findById(company._id).lean();
  for (const u of ['Panel', 'Kg', 'Lot', 'Bundle']) assert.ok(co.productUnits.some((x) => x.toLowerCase() === u.toLowerCase()), `unit ${u}`);

  // a showcase product got an older, cheaper second-source batch and a newer, dearer one
  const tata = await bySku('PNL-TP-440');
  const tb = await Batch.find({ product: tata._id }).sort({ receivedDate: 1 }).lean();
  assert.equal(tb.length, 4);
  assert.ok(tb[0].batchNo.endsWith('-S1') && tb.at(-1).batchNo.endsWith('-S2'));
  assert.ok(tb[0].retailPrice < tb[1].retailPrice && tb.at(-1).retailPrice > tb[2].retailPrice);
  assert.equal(new Set(tb.map((b) => String(b.supplier))).size, 3);
  assert.equal(await SerialUnit.countDocuments({ batch: tb[0]._id }), tb[0].qtyReceived);
  // the dormant supplier has nothing
  const dormant = await Supplier.findOne({ company: company._id, name: /Dormant/ }).lean();
  assert.equal(await Batch.countDocuments({ supplier: dormant._id }), 0);
});

test('re-running adds nothing; a dry run writes nothing; reset takes the seed away and leaves the showcase catalog', async () => {
  const baseline = { products: await Product.countDocuments({ company: company._id }), batches: await Batch.countDocuments({ company: company._id }), units: await SerialUnit.countDocuments({ company: company._id }), suppliers: await Supplier.countDocuments({ company: company._id }) };
  const dry = await seedInventory(company._id, { ...quiet, dryRun: true });
  assert.equal(dry.products, INVENTORY_PRODUCTS.length);
  assert.equal(await Product.countDocuments({ company: company._id }), baseline.products);
  assert.equal(await Supplier.countDocuments({ company: company._id }), baseline.suppliers);

  const first = await seedInventory(company._id, quiet);
  const again = await seedInventory(company._id, quiet);
  assert.deepEqual([again.suppliers, again.categories, again.products, again.batches, again.units], [0, 0, 0, 0, 0]);
  assert.equal(again.skipped.products, INVENTORY_PRODUCTS.length);
  assert.equal(again.skipped.batches, 2 * baseline.products);
  assert.equal(await Batch.countDocuments({ company: company._id }), baseline.batches + first.batches);

  const removed = await resetInventory(company._id, quiet);
  assert.equal(removed.products, INVENTORY_PRODUCTS.length);
  assert.equal(removed.suppliers, INVENTORY_SUPPLIERS.length);
  assert.equal(removed.category, 1);
  assert.deepEqual(
    { products: await Product.countDocuments({ company: company._id }), batches: await Batch.countDocuments({ company: company._id }), units: await SerialUnit.countDocuments({ company: company._id }), suppliers: await Supplier.countDocuments({ company: company._id }) },
    baseline,
  );
});

test('reset is refused once seeded stock has left', async () => {
  await seedInventory(company._id, quiet);
  const unit = await SerialUnit.findOne({ company: company._id, serialNo: /^PNL-WA-545B/ });
  await SerialUnit.updateOne({ _id: unit._id }, { $set: { status: 'sold' } });
  await assert.rejects(resetInventory(company._id, quiet), /Refusing to reset: 1 seeded unit/);
});

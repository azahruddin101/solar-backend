// Stock, batches, serial units and invoices against a real (in-memory) MongoDB replica set: the transactions and
// atomic updates only mean something there. Downloads a mongod binary on the first run.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Batch, Category, Client, Company, Design, Invoice, Product, Project, SerialUnit, Supplier } from '../src/models/index.js';
import { warrantyEndDate } from '../src/models/serialUnit.model.js';
import { billingService } from '../src/services/billing.service.js';
import { categoryService } from '../src/services/catalog.service.js';
import { supplierService } from '../src/services/supplier.service.js';
import { assertTransition, attachBatchBill, deductStock, inTransaction, listUnits, receiveStock, setUnitStatus, updateBatch } from '../src/services/stock.service.js';

let replSet;
let company;
let supplier;
let category;
const user = { _id: new mongoose.Types.ObjectId(), name: 'Owner', role: 'company' };
const prices = (retail) => ({ basePrice: retail - 20, wholesalePrice: retail - 10, retailPrice: retail, purchasePrice: retail - 40 });
const day = (n) => new Date(Date.UTC(2026, 0, n));

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
  await Promise.all([Batch, Invoice, SerialUnit, Company].map((M) => M.init())); // unique indexes exist before the tests
});

after(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  await Promise.all([Batch, Invoice, SerialUnit].map((M) => M.syncIndexes()));
  company = await Company.create({ name: 'Acme Solar' });
  supplier = await Supplier.create({ company: company._id, name: 'Sunrise' });
  category = await Category.create({ company: company._id, name: 'Cables' });
});

const product = (fields = {}) => Product.create({ company: company._id, category: category._id, name: 'DC cable 4 sq.mm', unit: 'Metre', ...fields });
const receive = (p, fields) => receiveStock(company, p._id, { supplier: supplier.id, ...fields });
const invoice = (lines) => billingService.createDirectInvoice(company, user, {
  billTo: { name: 'Walk-in customer' },
  pricing: { lines, gstIncluded: false, withGst: true, invoiceGstMode: 'with_gst' },
});

describe('batch creation', () => {
  test('needs base, wholesale and retail prices', async () => {
    const p = await product();
    for (const missing of ['basePrice', 'wholesalePrice', 'retailPrice']) {
      const body = { qtyReceived: 10, ...prices(100) };
      delete body[missing];
      await assert.rejects(receive(p, body), (e) => e.errors?.[missing] !== undefined, `${missing} should be required`);
    }
    assert.equal(await Batch.countDocuments(), 0);
    const batch = await receive(p, { qtyReceived: 10, ...prices(100) });
    assert.equal(batch.qtyRemaining, 10);
  });

  test('refuses negative prices', async () => {
    const p = await product();
    await assert.rejects(receive(p, { qtyReceived: 1, ...prices(100), wholesalePrice: -1 }), /0 or more/);
  });

  test('a serialized product gets one unit per serial number', async () => {
    const p = await product({ name: 'Panel 540 Wp', isSerialized: true, unit: 'Panel' });
    const batch = await receive(p, { serials: ['P-1', 'P-2', 'P-3'], ...prices(13000) });
    assert.equal(batch.qtyReceived, 3);
    assert.equal(await SerialUnit.countDocuments({ batch: batch._id, status: 'inStock' }), 3);
    await assert.rejects(receive(p, { serials: ['P-3', 'P-4'], ...prices(13000) }), /Already received: P-3/);
  });
});

describe('FIFO deduction', () => {
  test('takes from the oldest batch first and spans batches', async () => {
    const p = await product();
    const newer = await receive(p, { qtyReceived: 10, receivedDate: day(20), ...prices(120) });
    const older = await receive(p, { qtyReceived: 5, receivedDate: day(1), ...prices(100) });
    const allocations = await inTransaction((session) => deductStock(company, p, { qty: 8 }, session));
    assert.deepEqual(allocations.map((a) => [String(a.batch._id), a.qty]), [[older.id, 5], [newer.id, 3]]);
    assert.equal((await Batch.findById(older._id)).qtyRemaining, 0);
    assert.equal((await Batch.findById(newer._id)).qtyRemaining, 7);
  });

  test('a manually chosen batch is used instead of FIFO', async () => {
    const p = await product();
    await receive(p, { qtyReceived: 5, receivedDate: day(1), ...prices(100) });
    const chosen = await receive(p, { qtyReceived: 5, receivedDate: day(9), ...prices(120) });
    await inTransaction((session) => deductStock(company, p, { qty: 2, batch: chosen.id }, session));
    assert.equal((await Batch.findById(chosen._id)).qtyRemaining, 3);
  });

  test('fails without touching stock when there is not enough', async () => {
    const p = await product();
    const b = await receive(p, { qtyReceived: 4, ...prices(100) });
    await assert.rejects(inTransaction((session) => deductStock(company, p, { qty: 5 }, session)), /Only 4 Metre/);
    assert.equal((await Batch.findById(b._id)).qtyRemaining, 4);
  });
});

describe('serial units', () => {
  test('allowed status transitions', () => {
    for (const [from, to] of [['inStock', 'sold'], ['inStock', 'installed'], ['sold', 'installed'], ['sold', 'returned'], ['installed', 'returned'], ['returned', 'inStock']]) assert.doesNotThrow(() => assertTransition(from, to));
    for (const [from, to] of [['sold', 'inStock'], ['installed', 'sold'], ['returned', 'sold'], ['inStock', 'returned']]) assert.throws(() => assertTransition(from, to), /can't be marked/);
  });

  test('sold → installed → returned → in stock, and back into the batch', async () => {
    const p = await product({ name: 'Inverter 5 kW', isSerialized: true, unit: 'Piece', warrantyMonths: 60 });
    const batch = await receive(p, { serials: ['INV-1', 'INV-2'], ...prices(48000) });
    await invoice([{ name: 'Inverter', productId: p.id, serials: ['INV-1'], priceType: 'retail', rate: 0 }]);
    let unit = await SerialUnit.findOne({ serialNo: 'INV-1' });
    assert.equal(unit.status, 'sold');
    assert.ok(unit.soldInvoice);
    assert.equal((await Batch.findById(batch._id)).qtyRemaining, 1);

    const project = await Project.create({ company: company._id, design: new mongoose.Types.ObjectId(), client: new mongoose.Types.ObjectId(), steps: [] });
    unit = await setUnitStatus(company, unit.id, { status: 'installed', project: project.id, installDate: '2026-03-15' });
    assert.equal(unit.status, 'installed');
    await assert.rejects(setUnitStatus(company, unit.id, { status: 'sold' }), /can't be marked/);
    unit = await setUnitStatus(company, unit.id, { status: 'returned' });
    unit = await setUnitStatus(company, unit.id, { status: 'inStock' });
    assert.equal(unit.status, 'inStock');
    assert.equal(unit.soldInvoice, null);
    assert.equal((await Batch.findById(batch._id)).qtyRemaining, 2);
  });

  test('selling a unit that is not in stock fails', async () => {
    const p = await product({ name: 'Battery', isSerialized: true });
    await receive(p, { serials: ['B-1'], ...prices(16000) });
    await invoice([{ name: 'Battery', productId: p.id, serials: ['B-1'], priceType: 'retail', rate: 0 }]);
    await assert.rejects(invoice([{ name: 'Battery', productId: p.id, serials: ['B-1'], priceType: 'retail', rate: 0 }]), /Not in stock: B-1/);
    assert.equal(await Invoice.countDocuments(), 1);
  });
});

describe('unit list paging', () => {
  test('pages of 10 by default, larger pages on request, search by serial; unpaged returns everything', async () => {
    const p = await product({ name: 'Panel', isSerialized: true });
    await receive(p, { serials: Array.from({ length: 27 }, (_, i) => `PNL-${String(i + 1).padStart(3, '0')}`), ...prices(13000) });
    const first = await listUnits(company, p.id, { page: '1' });
    assert.deepEqual([first.items.length, first.total, first.page, first.limit], [10, 27, 1, 10]);
    const last = await listUnits(company, p.id, { page: '3', limit: '10' });
    assert.deepEqual(last.items.map((u) => u.serialNo), ['PNL-021', 'PNL-022', 'PNL-023', 'PNL-024', 'PNL-025', 'PNL-026', 'PNL-027']);
    assert.equal((await listUnits(company, p.id, { page: '1', limit: '25' })).items.length, 25);
    assert.equal((await listUnits(company, p.id, { page: '1', limit: '500' })).limit, 100); // capped
    const found = await listUnits(company, p.id, { page: '1', q: 'pnl-01' });
    assert.equal(found.total, 10); // PNL-010 … PNL-019, case-insensitive
    assert.equal((await listUnits(company, p.id, { page: '1', q: '.*' })).total, 0); // typed text, not a pattern
    assert.equal((await listUnits(company, p.id)).length, 27);
  });
});

describe('warranty', () => {
  test('ends warrantyMonths after the install date, not the sale', async () => {
    assert.equal(warrantyEndDate(new Date('2026-03-15T00:00:00Z'), 60).toISOString(), '2031-03-15T00:00:00.000Z');
    assert.equal(warrantyEndDate(new Date('2026-01-31T00:00:00Z'), 1).toISOString(), '2026-02-28T00:00:00.000Z'); // clamped to month end
    assert.equal(warrantyEndDate(new Date('2028-02-29T00:00:00Z'), 12).toISOString(), '2029-02-28T00:00:00.000Z');
    assert.equal(warrantyEndDate(null, 60), null); // sold but not installed yet: no warranty end

    const p = await product({ name: 'Panel', isSerialized: true, warrantyMonths: 300 });
    await receive(p, { serials: ['W-1'], ...prices(13000) });
    const project = await Project.create({ company: company._id, design: new mongoose.Types.ObjectId(), client: new mongoose.Types.ObjectId(), steps: [] });
    await invoice([{ name: 'Panel', productId: p.id, serials: ['W-1'], priceType: 'retail', rate: 0 }]);
    const [sold] = await listUnits(company, p.id);
    await setUnitStatus(company, sold.id, { status: 'installed', project: project.id, installDate: '2026-05-10' });
    const [unit] = await listUnits(company, p.id);
    assert.equal(unit.status, 'installed');
    assert.equal(unit.warrantyEnd.toISOString(), '2051-05-10T00:00:00.000Z');
    const populated = await SerialUnit.findById(unit.id).populate('product', 'warrantyMonths');
    assert.equal(populated.warrantyEnd.toISOString(), '2051-05-10T00:00:00.000Z'); // the model virtual agrees
  });
});

describe('invoice snapshot', () => {
  test('lines copy batch, serials, price type and rate; later batch edits do not change them', async () => {
    const p = await product();
    const older = await receive(p, { batchNo: 'A', qtyReceived: 3, receivedDate: day(1), ...prices(100) });
    await receive(p, { batchNo: 'B', qtyReceived: 10, receivedDate: day(5), ...prices(130) });
    const { createdInvoice } = await invoice([{ name: 'DC cable', productId: p.id, qty: 5, priceType: 'wholesale', rate: 1, gstPercent: 0 }, { name: 'Labour', qty: 1, rate: 500, gstPercent: 0 }]);
    const lines = createdInvoice.pricing.lines;
    assert.deepEqual(lines.map((l) => [l.batchNo, l.qty, l.priceType, l.rate]), [['A', 3, 'wholesale', 90], ['B', 2, 'wholesale', 120], [undefined, 1, undefined, 500]]);
    assert.equal(createdInvoice.total, 3 * 90 + 2 * 120 + 500); // the client's rate of 1 is ignored for stock lines

    await updateBatch(company, older.id, { wholesalePrice: 999, batchNo: 'A-renamed' });
    const stored = await Invoice.findById(createdInvoice.id).lean();
    assert.deepEqual(stored.pricing.lines[0], lines[0]);
    assert.equal(stored.total, createdInvoice.total);
  });

  test('no invoice and no stock change when a line fails', async () => {
    const p = await product();
    const b = await receive(p, { qtyReceived: 2, ...prices(100) });
    await assert.rejects(invoice([{ name: 'ok', productId: p.id, qty: 2, priceType: 'retail', rate: 0 }, { name: 'too many', productId: p.id, qty: 1, priceType: 'retail', rate: 0 }]), /Only 0/);
    assert.equal(await Invoice.countDocuments(), 0);
    assert.equal((await Batch.findById(b._id)).qtyRemaining, 2);
  });
});

describe('supplier bills', () => {
  test('a bill is kept with the batch, replaced by a newer one, and listed under the supplier', async () => {
    const p = await product();
    const b = await receive(p, { batchNo: 'BILL-1', qtyReceived: 5, ...prices(100) });
    const first = await attachBatchBill(company, b.id, { filename: `${company.id}-bill-${b.id}-aaaa.pdf`, originalname: 'sunrise-0042.pdf' });
    assert.equal(first.billName, 'sunrise-0042.pdf');
    assert.match(first.billUrl, /-bill-/);
    const second = await attachBatchBill(company, b.id, { filename: `${company.id}-bill-${b.id}-bbbb.png`, originalname: 'scan.png' });
    assert.equal(second.billUrl.endsWith('bbbb.png'), true);
    const rows = await supplierService.purchases(company, String(b.supplier));
    assert.deepEqual(rows.map((r) => [r.batchNo, r.qtyReceived, r.billName]), [['BILL-1', 5, 'scan.png']]);
    await assert.rejects(attachBatchBill(company, new mongoose.Types.ObjectId().toString(), { filename: 'x.pdf' }), /not found/i);
    await assert.rejects(attachBatchBill(company, b.id, null), /Choose the bill/);
  });
});

describe('supplier categories', () => {
  test('a supplier keeps the product categories it sells (optional, no repeats, own company only)', async () => {
    const panels = await Category.create({ company: company._id, name: 'Panels' });
    const made = await supplierService.create(company, { name: 'Volt Traders', categories: [panels.id, category.id, panels.id] });
    assert.deepEqual(made.categories.map(String), [panels.id, category.id]);
    assert.deepEqual((await supplierService.create(company, { name: 'No category' })).categories, []);

    const foreign = await Category.create({ company: new mongoose.Types.ObjectId(), name: 'Theirs' });
    await assert.rejects(supplierService.update(company, made.id, { categories: [foreign.id] }), /product categories/);
    const kept = await supplierService.update(company, made.id, { phone: '9876543210' }); // categories not sent: unchanged
    assert.equal(kept.categories.length, 2);
    assert.deepEqual((await supplierService.update(company, made.id, { categories: [] })).categories, []);
  });

  test('deleting a category takes it off its suppliers', async () => {
    const panels = await Category.create({ company: company._id, name: 'Panels' });
    const s = await supplierService.create(company, { name: 'Volt Traders', categories: [panels.id, category.id] });
    await categoryService.remove(company, panels.id);
    assert.deepEqual((await Supplier.findById(s.id)).categories.map(String), [category.id]);
  });
});

describe('concurrent sales', () => {
  test('two simultaneous sales cannot oversell a batch', async () => {
    const p = await product();
    const b = await receive(p, { qtyReceived: 10, ...prices(100) });
    const sale = () => invoice([{ name: 'DC cable', productId: p.id, qty: 6, priceType: 'retail', rate: 0 }]);
    const results = await Promise.allSettled([sale(), sale()]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /Only 4 Metre/);
    assert.equal((await Batch.findById(b._id)).qtyRemaining, 4);
    assert.equal(await Invoice.countDocuments(), 1);
  });

  test('the atomic guard alone refuses a deduction the batch no longer covers', async () => {
    const p = await product();
    const b = await receive(p, { qtyReceived: 5, ...prices(100) });
    await Batch.updateOne({ _id: b._id }, { $inc: { qtyRemaining: -4 } }); // someone else sold 4 meanwhile
    await assert.rejects(inTransaction((session) => deductStock(company, p, { qty: 3, batch: b.id }, session)), /has only 1 Metre left/);
  });

  test('many parallel sales of one serial: exactly one wins', async () => {
    const p = await product({ name: 'Inverter', isSerialized: true });
    await receive(p, { serials: ['ONE'], ...prices(48000) });
    const sale = () => invoice([{ name: 'Inverter', productId: p.id, serials: ['ONE'], priceType: 'retail', rate: 0 }]);
    const results = await Promise.allSettled(Array.from({ length: 5 }, sale));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await Invoice.countDocuments(), 1);
    assert.equal(await SerialUnit.countDocuments({ status: 'sold' }), 1);
  });
});

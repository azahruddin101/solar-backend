// The sale chain against an in-memory replica set: goods leave stock on an e-way bill, one or more e-way bills plus
// services are paid on a bill (which records the payment), and an invoice consolidates the bills as they were paid.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Batch, Bill, Category, Client, Company, CreditNote, Design, EwayBill, InstallationCharge, Invoice, Payment, Product, SerialUnit, Supplier } from '../src/models/index.js';
import { billService } from '../src/services/bill.service.js';
import { billingService } from '../src/services/billing.service.js';
import { deleteClient } from '../src/services/client.service.js';
import { deleteDesign, updateDesign } from '../src/services/design.service.js';
import { cleanTransport, ewayBillService } from '../src/services/ewayBill.service.js';
import { consolidatePricing } from '../src/services/invoicePricing.service.js';
import { receiveStock, setUnitStatus } from '../src/services/stock.service.js';
import { creditNoteService, returnableOf } from '../src/services/creditNote.service.js';

let replSet;
let company;
let client;
let design;
let cable; // per batch, 18% GST
let panel; // serialized, 12% GST
const user = { _id: new mongoose.Types.ObjectId(), name: 'Owner', role: 'company' };
const prices = (retail) => ({ basePrice: retail - 20, wholesalePrice: retail - 10, retailPrice: retail, purchasePrice: retail - 40 });
const paid = (extra = {}) => ({ mode: 'upi', reference: 'UPI-1', ...extra });

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
  await Promise.all([Batch, Bill, EwayBill, Invoice, Payment, SerialUnit, Company].map((M) => M.init()));
});

after(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  await Promise.all([Batch, Bill, EwayBill, Invoice, Payment, SerialUnit].map((M) => M.syncIndexes()));
  company = await Company.create({ name: 'Acme Solar' });
  const supplier = await Supplier.create({ company: company._id, name: 'Sunrise' });
  const category = await Category.create({ company: company._id, name: 'Solar' });
  cable = await Product.create({ company: company._id, category: category._id, name: 'DC cable', unit: 'Metre', gstPercent: 18, hsnCode: '8544' });
  panel = await Product.create({ company: company._id, category: category._id, name: 'Panel 540 Wp', unit: 'Nos', gstPercent: 12, isSerialized: true, hsnCode: '8541' });
  await receiveStock(company, cable._id, { supplier: supplier.id, qtyReceived: 100, ...prices(100) });
  await receiveStock(company, panel._id, { supplier: supplier.id, serials: ['P-1', 'P-2', 'P-3'], ...prices(10000) });
  client = await Client.create({ company: company._id, name: 'Sunil Patil', phone: '9876543210' });
  design = await Design.create({ company: company._id, client: client._id, name: 'Patil bungalow', status: 'won', summary: { pricing: { total: 200000 }, cost: 200000 } });
});

const eway = (lines, extra = {}) => ewayBillService.create(company, user, { design: design.id, lines, withGst: true, transport: { vehicleNo: 'mh 12 ab 1234', toPlace: 'Site' }, ...extra });

describe('e-way bills', () => {
  test('take the goods out of stock, price them from their batches and get a running number', async () => {
    const e = await eway([{ productId: cable.id, qty: 10, priceType: 'retail' }, { productId: panel.id, serials: ['P-1', 'P-2'], priceType: 'wholesale' }]);
    assert.equal(e.ewayNo, 'EWB-0001');
    assert.equal(e.status, 'open');
    assert.equal(e.title, 'Patil bungalow');
    assert.equal(e.transport.vehicleNo, 'MH12AB1234');
    assert.deepEqual(e.lines.map((l) => [l.name, l.qty, l.rate, l.kind]), [['DC cable', 10, 100, 'goods'], ['Panel 540 Wp', 2, 9990, 'goods']]);
    assert.equal(e.total, 23557.6); // 10 × 100 + 18% and 2 × 9990 + 12%
    assert.equal(e.itemCount, 12);
    assert.equal((await Batch.findOne({ product: cable._id })).qtyRemaining, 90);
    const unit = await SerialUnit.findOne({ serialNo: 'P-1' });
    assert.equal(unit.status, 'sold');
    assert.equal(String(unit.soldEwayBill), e.id);
    assert.equal(unit.soldInvoice, null);
    assert.equal((await eway([{ productId: cable.id, qty: 1, priceType: 'retail' }])).ewayNo, 'EWB-0002');
  });

  test('every line must be a product from stock, and the proposal must be booked', async () => {
    await assert.rejects(eway([{ name: 'Labour', rate: 500 }]), /product from stock/);
    await assert.rejects(eway([]), /at least one product/);
    await Design.updateOne({ _id: design._id }, { status: 'draft' });
    await assert.rejects(eway([{ productId: cable.id, qty: 1, priceType: 'retail' }]), /must be Booked/);
    assert.equal((await Batch.findOne({ product: cable._id })).qtyRemaining, 100); // nothing was taken
  });

  test('not enough stock fails without taking anything, and the 12-digit portal number is checked', async () => {
    await assert.rejects(eway([{ productId: cable.id, qty: 500, priceType: 'retail' }]), /Only 100 Metre/);
    assert.equal(await EwayBill.countDocuments(), 0);
    await assert.rejects(eway([{ productId: cable.id, qty: 1, priceType: 'retail' }], { govtEwayNo: '12345' }), /12 digits/);
    const e = await eway([{ productId: cable.id, qty: 1, priceType: 'retail' }], { govtEwayNo: '1234 5678 9012' });
    assert.equal(e.govtEwayNo, '123456789012');
  });

  test('cancelling an open e-way bill puts the goods back; a billed one can’t be cancelled', async () => {
    const e = await eway([{ productId: cable.id, qty: 10, priceType: 'retail' }, { productId: panel.id, serials: ['P-3'], priceType: 'retail' }]);
    const cancelled = await ewayBillService.cancel(company, e.id, { reason: 'Vehicle did not come' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelReason, 'Vehicle did not come');
    assert.equal((await Batch.findOne({ product: cable._id })).qtyRemaining, 100);
    assert.equal((await Batch.findOne({ product: panel._id })).qtyRemaining, 3);
    assert.equal((await SerialUnit.findOne({ serialNo: 'P-3' })).status, 'inStock');
    await assert.rejects(ewayBillService.cancel(company, e.id), /already cancelled/);
    assert.deepEqual(await ewayBillService.open(company, { design: design.id }), []);

    const kept = await eway([{ productId: cable.id, qty: 5, priceType: 'retail' }]);
    await billService.create(company, user, { design: design.id, ewayBills: [kept.id], payment: paid() });
    await assert.rejects(ewayBillService.cancel(company, kept.id), /on a bill/);
  });

  test('a client with no proposal can have e-way bills too', async () => {
    const walkIn = await Client.create({ company: company._id, name: 'Walk-in Buyer' });
    const e = await ewayBillService.create(company, user, { client: walkIn.id, lines: [{ productId: cable.id, qty: 2, priceType: 'retail' }], withGst: false });
    assert.equal(e.design, null);
    assert.equal(e.title, 'Walk-in Buyer');
    assert.equal(e.total, 200);
    assert.equal((await ewayBillService.open(company, { client: walkIn.id })).length, 1);
    assert.equal((await ewayBillService.open(company, { design: design.id })).length, 0);
    await assert.rejects(ewayBillService.create(company, user, { lines: [{ productId: cable.id, qty: 2, priceType: 'retail' }] }), /Choose the client/);
  });

  test('transport details are cleaned', () => {
    assert.deepEqual(cleanTransport({ mode: 'rail', vehicleNo: ' mh-12 ab 1234 ', distanceKm: '42', reason: 'bogus', bogus: 'x' }), {
      mode: 'rail', reason: 'supply', vehicleNo: 'MH-12AB1234', transporter: '', transporterId: '', docNo: '', docDate: '', fromPlace: '', toPlace: '', distanceKm: 42,
    });
    assert.throws(() => cleanTransport({ distanceKm: -1 }), /0 or more/);
    assert.equal(cleanTransport(undefined).mode, 'road');
  });
});

describe('bills', () => {
  test('gather e-way bills and services, apply a discount, record the payment and mark the e-way bills billed', async () => {
    const charge = await InstallationCharge.create({ company: company._id, name: 'Installation', defaultPrice: 5000, gstPercent: 18, sac: '998736' });
    const e1 = await eway([{ productId: cable.id, qty: 10, priceType: 'retail' }]); // 1000 + 18%
    const e2 = await eway([{ productId: panel.id, serials: ['P-1'], priceType: 'retail' }]); // 10000 + 12%
    const res = await billService.create(company, user, {
      design: design.id,
      ewayBills: [e1.id, e2.id],
      services: [{ chargeId: charge.id, rate: 5000 }, { name: 'Transport', rate: 1500, gstPercent: 5, hsn: '996511' }],
      discount: 10,
      discountIsPercent: true,
      discountRemark: 'Festive offer',
      payment: paid({ receivedOn: '2026-10-20', note: 'Cash and UPI' }),
    });
    const { bill, payment } = res;
    assert.equal(bill.billNo, 'BILL-0001');
    assert.equal(bill.status, 'paid');
    assert.deepEqual(bill.pricing.lines.map((l) => [l.kind, l.name, l.ewayNo || '']), [['goods', 'DC cable', 'EWB-0001'], ['goods', 'Panel 540 Wp', 'EWB-0002'], ['service', 'Installation', ''], ['service', 'Transport', '']]);
    assert.equal(bill.services[0].name, 'Installation'); // copied from the charge
    assert.equal(bill.services[0].hsn, '998736'); // the charge's SAC
    assert.equal(bill.services[1].hsn, '996511'); // typed on the custom service
    // gross 1000 + 10000 + 5000 + 1500 = 17500, 10% off → 15750; GST per line on 90%: 162 + 1080 + 810 + 67.5
    assert.equal(bill.pricing.subtotal, 15750);
    assert.equal(bill.pricing.discountAmount, 1750);
    assert.equal(bill.pricing.discountRemark, 'Festive offer');
    assert.equal(bill.pricing.gstTotal, 2119.5);
    assert.equal(bill.total, 17869.5);
    assert.equal(bill.paid.mode, 'upi');
    assert.equal(bill.paid.amount, 17869.5);
    assert.deepEqual(bill.ewayBills.map((e) => e.ewayNo), ['EWB-0001', 'EWB-0002']);

    assert.equal(payment.receiptNo, 'BILL-0001'); // the bill is the payment document
    assert.equal(payment.amount, 17869.5);
    assert.equal(String(payment.bill), bill.id);
    assert.equal(payment.contractTotal, 200000);
    assert.equal(payment.balanceAfter, 200000 - 17869.5);
    assert.match(payment.note, /Bill BILL-0001 · Cash and UPI/);
    assert.equal(new Date(payment.receivedOn).toISOString().slice(0, 10), '2026-10-20');

    for (const e of [e1, e2]) {
      const row = await EwayBill.findById(e.id);
      assert.equal(row.status, 'billed');
      assert.equal(String(row.bill), bill.id);
    }
    const ledger = await billingService.get(company, design.id);
    assert.equal(ledger.paid, 17869.5);
    assert.equal(ledger.openEwayBills, 0);
    assert.equal(ledger.uninvoicedBills, 1);
    assert.equal(ledger.bills[0].billNo, 'BILL-0001');
  });

  test('an e-way bill goes on one bill only; a bill needs something on it and a payment mode', async () => {
    const e = await eway([{ productId: cable.id, qty: 1, priceType: 'retail' }]);
    await billService.create(company, user, { design: design.id, ewayBills: [e.id], payment: paid() });
    await assert.rejects(billService.create(company, user, { design: design.id, ewayBills: [e.id], payment: paid() }), /already on a bill/);
    await assert.rejects(billService.create(company, user, { design: design.id, ewayBills: [], services: [], payment: paid() }), /at least one e-way bill/);
    await assert.rejects(billService.create(company, user, { design: design.id, services: [{ name: 'Visit', rate: 500 }], payment: {} }), /how the bill was paid/);
    assert.equal(await Bill.countDocuments(), 1);
    assert.equal(await Payment.countDocuments(), 1);
  });

  test('another proposal’s e-way bill can’t be billed here; a services-only bill works', async () => {
    const other = await Design.create({ company: company._id, client: client._id, name: 'Other site', status: 'won', summary: { pricing: { total: 50000 } } });
    const e = await ewayBillService.create(company, user, { design: other.id, lines: [{ productId: cable.id, qty: 1, priceType: 'retail' }] });
    await assert.rejects(billService.create(company, user, { design: design.id, ewayBills: [e.id], payment: paid() }), /not found/i);
    const { bill } = await billService.create(company, user, { design: design.id, services: [{ name: 'Site visit', rate: 500, gstPercent: 0 }], withGst: false, payment: paid({ mode: 'cash' }) });
    assert.equal(bill.total, 500);
    assert.deepEqual(bill.ewayBills, []);
  });
});

describe('invoices from bills', () => {
  test('consolidate the bills exactly as paid, mark them invoiced and point the sold units at the invoice', async () => {
    const e1 = await eway([{ productId: cable.id, qty: 10, priceType: 'retail' }]);
    const e2 = await eway([{ productId: panel.id, serials: ['P-1', 'P-2'], priceType: 'retail' }]);
    const b1 = (await billService.create(company, user, { design: design.id, ewayBills: [e1.id], discount: 100, payment: paid() })).bill; // 900 + 162
    const b2 = (await billService.create(company, user, { design: design.id, ewayBills: [e2.id], services: [{ name: 'Installation', rate: 5000 }], payment: paid() })).bill; // 20000 + 2400 + 5000 + 900
    const { createdInvoice: inv } = await billingService.createInvoiceFromBills(company, user, { design: design.id, billToCompany: 'Patil Industries', details: { destination: 'Nashik' } }); // no `bills`: every paid bill
    assert.equal(inv.total, b1.total + b2.total);
    assert.equal(inv.total, 29362);
    assert.equal(inv.pricing.fromBills, true);
    assert.equal(inv.pricing.discountAmount, 100);
    assert.equal(inv.pricing.gstTotal, 162 + 2400 + 900);
    assert.deepEqual(inv.pricing.lines.map((l) => [l.name, l.billNo]), [['DC cable', 'BILL-0001'], ['Panel 540 Wp', 'BILL-0002'], ['Installation', 'BILL-0002']]);
    assert.deepEqual(inv.pricing.taxByHsn.map((r) => [r.hsn, r.taxable, r.gst]), [['8544', 900, 162], ['8541', 20000, 2400], ['—', 5000, 900]]); // a service with no SAC
    assert.deepEqual(inv.billRefs.map((r) => [r.billNo, r.total, r.ewayNos]), [['BILL-0001', b1.total, ['EWB-0001']], ['BILL-0002', b2.total, ['EWB-0002']]]);
    assert.equal(inv.billToCompany, 'Patil Industries');
    assert.equal(inv.details.destination, 'Nashik');
    assert.equal(String(inv.client), client.id);
    for (const b of [b1, b2]) {
      const row = await Bill.findById(b.id);
      assert.equal(row.status, 'invoiced');
      assert.equal(String(row.invoice), inv.id);
    }
    const unit = await SerialUnit.findOne({ serialNo: 'P-2' });
    assert.equal(String(unit.soldInvoice), inv.id);
    assert.equal(String(unit.soldEwayBill), e2.id);
    const ledger = await billingService.get(company, design.id);
    assert.equal(ledger.uninvoicedBills, 0);
    assert.equal(ledger.invoices[0].invoiceNo, inv.invoiceNo);
    await assert.rejects(billingService.createInvoiceFromBills(company, user, { design: design.id, bills: [b1.id] }), /already invoiced/);
    await assert.rejects(billingService.createInvoiceFromBills(company, user, { design: design.id }), /no paid bill/);
  });

  test('GST and no-GST bills go on one invoice, and a client-only chain invoices with the client’s details', async () => {
    const walkIn = await Client.create({ company: company._id, name: 'Walk-in Buyer', address: 'MG Road, Pune', gstNumber: '27ABCDE1234F1Z5' });
    const e = await ewayBillService.create(company, user, { client: walkIn.id, lines: [{ productId: cable.id, qty: 3, priceType: 'retail' }], withGst: false });
    const plain = (await billService.create(company, user, { client: walkIn.id, ewayBills: [e.id], withGst: false, payment: paid({ mode: 'cash' }) })).bill;
    const taxed = (await billService.create(company, user, { client: walkIn.id, services: [{ name: 'Visit', rate: 1000 }], withGst: true, payment: paid({ mode: 'cash' }) })).bill;
    const mixed = consolidatePricing([plain, taxed]);
    assert.equal(mixed.withGst, true); // a tax invoice as soon as one bill carried GST
    assert.equal(mixed.total, 300 + 1180);
    assert.equal(mixed.gstTotal, 180);
    const onlyPlain = consolidatePricing([plain]);
    assert.equal(onlyPlain.withGst, false);
    const { createdInvoice: inv } = await billingService.createInvoiceFromBills(company, user, { client: walkIn.id });
    assert.equal(inv.design, null);
    assert.equal(inv.total, 1480); // both bills
    assert.deepEqual(inv.billRefs.map((r) => r.billNo), [plain.billNo, taxed.billNo]);
    assert.deepEqual(inv.billTo, { name: 'Walk-in Buyer', company: '', phone: '', email: '', address: 'MG Road, Pune', gstNumber: '27ABCDE1234F1Z5' });
    const ledger = await billingService.getClient(company, walkIn.id);
    assert.equal(ledger.client.name, 'Walk-in Buyer');
    assert.equal(ledger.total, plain.total + taxed.total);
    assert.equal(ledger.paid, plain.total + taxed.total);
    assert.equal(ledger.uninvoicedBills, 0);
    assert.equal(ledger.invoices.length, 1);
    assert.equal((await Payment.countDocuments({ company: company._id, client: walkIn._id })), 2); // one payment row per bill
  });
});

describe('goods out of stock lock the proposal and the client', () => {
  test('an open e-way bill stops a proposal from being deleted, closed or changed until it is cancelled', async () => {
    const e = await eway([{ productId: cable.id, qty: 4, priceType: 'retail' }]);
    await assert.rejects(deleteDesign(company, design.id), /e-way bills, bills or an invoice/);
    await assert.rejects(updateDesign(company, user, design.id, { status: 'lost' }), /status can’t be changed/);
    await assert.rejects(updateDesign(company, user, design.id, { summary: { cost: 1, pricing: { total: 1 } } }), /price can’t be changed/);
    await assert.rejects(deleteClient(company, client.id, user), /e-way bills, bills or invoices/);
    assert.equal(await Design.countDocuments({ _id: design._id }), 1);

    await ewayBillService.cancel(company, e.id, { reason: 'Changed mind' });
    assert.equal((await updateDesign(company, user, design.id, { status: 'lost' })).status, 'lost');
    await deleteDesign(company, design.id);
    assert.equal(await Design.countDocuments({ _id: design._id }), 0);
    assert.equal((await Batch.findOne({ product: cable._id })).qtyRemaining, 100); // the goods came back
  });

  test('a client with only an open e-way bill (no proposal) cannot be deleted', async () => {
    const walkIn = await Client.create({ company: company._id, name: 'Walk-in Buyer' });
    const e = await ewayBillService.create(company, user, { client: walkIn.id, lines: [{ productId: cable.id, qty: 2, priceType: 'retail' }], withGst: false });
    await assert.rejects(deleteClient(company, walkIn.id, user), /e-way bills, bills or invoices/);
    assert.equal(await Client.countDocuments({ _id: walkIn._id }), 1);
    await ewayBillService.cancel(company, e.id);
    await deleteClient(company, walkIn.id, user);
    assert.equal(await Client.countDocuments({ _id: walkIn._id }), 0);
  });
});

describe('serial units on an open e-way bill', () => {
  test('a unit cannot be marked installed or returned by hand while its e-way bill is open', async () => {
    const e = await eway([{ productId: panel.id, serials: ['P-1'], priceType: 'retail' }]);
    const unit = await SerialUnit.findOne({ serialNo: 'P-1' });
    await assert.rejects(setUnitStatus(company, unit.id, { status: 'returned' }), /still open/);
    assert.equal((await SerialUnit.findById(unit.id)).status, 'sold');
    await ewayBillService.cancel(company, e.id);
    assert.equal((await SerialUnit.findById(unit.id)).status, 'inStock');
    assert.equal((await Batch.findOne({ product: panel._id })).qtyRemaining, 3);
  });

  test('once the e-way bill is billed the unit can move on', async () => {
    const e = await eway([{ productId: panel.id, serials: ['P-2'], priceType: 'retail' }]);
    await billService.create(company, user, { design: design.id, ewayBills: [e.id], payment: paid() });
    const unit = await SerialUnit.findOne({ serialNo: 'P-2' });
    assert.equal((await setUnitStatus(company, unit.id, { status: 'returned' })).status, 'returned');
  });

  test('cancelling gives the batch back only the units it restored (data that drifted before the guard)', async () => {
    const e = await eway([{ productId: panel.id, serials: ['P-1', 'P-2'], priceType: 'retail' }]);
    await SerialUnit.updateOne({ serialNo: 'P-1' }, { $set: { status: 'returned' } }); // changed by hand, as old data could be
    await ewayBillService.cancel(company, e.id);
    assert.equal((await SerialUnit.findOne({ serialNo: 'P-1' })).status, 'returned');
    assert.equal((await SerialUnit.findOne({ serialNo: 'P-2' })).status, 'inStock');
    assert.equal((await Batch.findOne({ product: panel._id })).qtyRemaining, 2); // 3 received − 2 sold + 1 restored
    assert.equal(await SerialUnit.countDocuments({ product: panel._id, status: 'inStock' }), 2); // batch count equals units in stock
  });
});

describe('repeating a create request with the same key', () => {
  test('an e-way bill is made once: the second request returns it and takes no more stock', async () => {
    const lines = [{ productId: cable.id, qty: 10, priceType: 'retail' }];
    const first = await eway(lines, { idempotencyKey: 'key-eway-0001' });
    const again = await eway(lines, { idempotencyKey: 'key-eway-0001' });
    assert.equal(again.id, first.id);
    assert.equal(again.ewayNo, 'EWB-0001');
    assert.equal(await EwayBill.countDocuments(), 1);
    assert.equal((await Batch.findOne({ product: cable._id })).qtyRemaining, 90);
    const other = await eway(lines, { idempotencyKey: 'key-eway-0002' }); // a different key is a different sale
    assert.equal(other.ewayNo, 'EWB-0002');
    assert.equal((await Batch.findOne({ product: cable._id })).qtyRemaining, 80);
    await eway(lines); // no key: no protection, as before
    assert.equal(await EwayBill.countDocuments(), 3);
  });

  test('two requests at the same moment still make one e-way bill and take the stock once', async () => {
    const lines = [{ productId: panel.id, serials: ['P-1'], priceType: 'retail' }];
    const results = await Promise.allSettled([eway(lines, { idempotencyKey: 'key-race-0001' }), eway(lines, { idempotencyKey: 'key-race-0001' })]);
    assert.ok(results.every((r) => r.status === 'fulfilled'), results.map((r) => r.reason?.message).join(' | '));
    assert.equal(results[0].value.id, results[1].value.id);
    assert.equal(await EwayBill.countDocuments(), 1);
    assert.equal(await SerialUnit.countDocuments({ status: 'sold' }), 1);
  });

  test('a bill records its payment once, and an invoice is made once', async () => {
    const e = await eway([{ productId: cable.id, qty: 5, priceType: 'retail' }]);
    const body = { design: design.id, ewayBills: [e.id], payment: paid(), idempotencyKey: 'key-bill-0001' };
    const first = await billService.create(company, user, body);
    const again = await billService.create(company, user, body); // would fail as "already on a bill" without the key
    assert.equal(again.bill.id, first.bill.id);
    assert.equal(again.payment.id, first.payment.id);
    assert.deepEqual(again.bill.ewayBills.map((x) => x.ewayNo), ['EWB-0001']);
    assert.equal(await Bill.countDocuments(), 1);
    assert.equal(await Payment.countDocuments(), 1);

    const invoiceBody = { design: design.id, idempotencyKey: 'key-inv-0001' };
    const invoice = await billingService.createInvoiceFromBills(company, user, invoiceBody);
    const invoiceAgain = await billingService.createInvoiceFromBills(company, user, invoiceBody);
    assert.equal(invoiceAgain.createdInvoice.id, invoice.createdInvoice.id);
    assert.equal(await Invoice.countDocuments(), 1);
  });

  test('a services-only bill repeated with the same key does not record a second payment', async () => {
    const body = { client: client.id, services: [{ name: 'Wiring', qty: 1, rate: 1000, gstPercent: 18 }], payment: paid(), idempotencyKey: 'key-svc-00001' };
    const first = await billService.create(company, user, body);
    const again = await billService.create(company, user, body);
    assert.equal(again.bill.id, first.bill.id);
    assert.equal(await Payment.countDocuments(), 1);
  });
});

describe('voiding a bill or an invoice', () => {
  const billOf = async (lines = [{ productId: cable.id, qty: 10, priceType: 'retail' }]) => {
    const e = await eway(lines);
    const { bill } = await billService.create(company, user, { design: design.id, ewayBills: [e.id], payment: paid() });
    return { e, bill };
  };

  test('voiding a bill removes its payment and reopens its e-way bills, and the bill stays as the record', async () => {
    const { e, bill } = await billOf();
    assert.equal(await Payment.countDocuments(), 1);
    await assert.rejects(billService.void(company, user, bill.id, {}), /reason/);
    const voided = await billService.void(company, user, bill.id, { reason: 'Wrong GST rate', returnStock: false });
    assert.equal(voided.status, 'void');
    assert.equal(voided.voidReason, 'Wrong GST rate');
    assert.equal(voided.voidedByName, 'Owner');
    assert.equal(voided.payment ?? null, null);
    assert.equal(voided.paid.amount, bill.total); // what was paid is still on the bill
    assert.equal(await Payment.countDocuments(), 0);
    const ledger = await billingService.get(company, design.id);
    assert.equal(ledger.paid, 0);
    const reopened = await EwayBill.findById(e.id);
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.bill, null);
    assert.equal((await Batch.findOne({ product: cable._id })).qtyRemaining, 90); // goods are still out
    await assert.rejects(billService.void(company, user, bill.id, { reason: 'again' }), /already void/);
    assert.deepEqual(await billService.uninvoiced(company, { design: design.id }), []); // a void bill can't be invoiced
    // the e-way bill can be billed again, and the new bill gets a new number
    const again = await billService.create(company, user, { design: design.id, ewayBills: [e.id], payment: paid() });
    assert.equal(again.bill.billNo, 'BILL-0002');
  });

  test('voiding a bill with "return stock" cancels its e-way bills and puts the goods back', async () => {
    const { e, bill } = await billOf([{ productId: cable.id, qty: 10, priceType: 'retail' }, { productId: panel.id, serials: ['P-1'], priceType: 'retail' }]);
    await billService.void(company, user, bill.id, { reason: 'Customer returned everything', returnStock: true });
    const cancelled = await EwayBill.findById(e.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.match(cancelled.cancelReason, /BILL-0001 voided: Customer returned everything/);
    assert.equal((await Batch.findOne({ product: cable._id })).qtyRemaining, 100);
    assert.equal((await SerialUnit.findOne({ serialNo: 'P-1' })).status, 'inStock');
    assert.equal(await Payment.countDocuments(), 0);
  });

  test('returning stock is refused, and nothing changes, when a unit was installed after the sale', async () => {
    const { bill } = await billOf([{ productId: panel.id, serials: ['P-1'], priceType: 'retail' }]);
    await SerialUnit.updateOne({ serialNo: 'P-1' }, { $set: { status: 'installed' } });
    await assert.rejects(billService.void(company, user, bill.id, { reason: 'x', returnStock: true }), /no longer sold/);
    assert.equal((await Bill.findById(bill.id)).status, 'paid');
    assert.equal(await Payment.countDocuments(), 1);
    assert.equal((await billService.void(company, user, bill.id, { reason: 'x', returnStock: false })).status, 'void'); // without returning stock it works
  });

  test('a bill on an invoice can only be voided after the invoice is; voiding the invoice frees its bills', async () => {
    const { bill } = await billOf([{ productId: panel.id, serials: ['P-2'], priceType: 'retail' }]);
    const { createdInvoice } = await billingService.createInvoiceFromBills(company, user, { design: design.id });
    await assert.rejects(billService.void(company, user, bill.id, { reason: 'x' }), /Void that invoice first/);
    assert.equal((await SerialUnit.findOne({ serialNo: 'P-2' })).soldInvoice?.toString(), createdInvoice.id);

    await assert.rejects(billingService.voidInvoice(company, user, createdInvoice.id, {}), /reason/);
    const voided = await billingService.voidInvoice(company, user, createdInvoice.id, { reason: 'Wrong buyer name' });
    assert.equal(voided.status, 'void');
    assert.equal(voided.invoiceNo, createdInvoice.invoiceNo);
    const freed = await Bill.findById(bill.id);
    assert.equal(freed.status, 'paid');
    assert.equal(freed.invoice, null);
    assert.equal((await SerialUnit.findOne({ serialNo: 'P-2' })).soldInvoice, null);
    await assert.rejects(billingService.voidInvoice(company, user, createdInvoice.id, { reason: 'again' }), /already void/);

    const ledger = await billingService.get(company, design.id);
    assert.equal(ledger.invoice, null); // the voided invoice no longer stands as the proposal's invoice
    assert.equal(ledger.invoices.length, 1); // but it is still listed, marked void
    assert.equal(ledger.uninvoicedBills, 1);

    const next = await billingService.createInvoiceFromBills(company, user, { design: design.id });
    assert.notEqual(next.createdInvoice.invoiceNo, createdInvoice.invoiceNo); // a voided number is never reused
    assert.equal((await billingService.get(company, design.id)).invoice.invoiceNo, next.createdInvoice.invoiceNo);
  });

  test('an invoice with no bills (AMC parts) is not voided here', async () => {
    const amc = await Invoice.create({ company: company._id, design: design._id, client: client._id, invoiceNo: 'INV-AMC-1', total: 100 });
    await assert.rejects(billingService.voidInvoice(company, user, amc.id, { reason: 'x' }), /made from bills/);
  });

  test('a proposal or client with only a void bill still can’t be deleted', async () => {
    const svc = await billService.create(company, user, { design: design.id, services: [{ name: 'Wiring', qty: 1, rate: 500, gstPercent: 0 }], payment: paid() });
    await billService.void(company, user, svc.bill.id, { reason: 'Entered twice' });
    await assert.rejects(deleteDesign(company, design.id), /e-way bills, bills or an invoice/);
    await assert.rejects(deleteClient(company, client.id, user), /e-way bills, bills or invoices/);
  });
});

describe('credit notes: only some of the goods on a paid bill come back', () => {
  const refund = (extra = {}) => ({ mode: 'upi', reference: 'REF-1', ...extra });
  // 10 m of cable (18% GST) and 2 serialized panels (12% GST), 10% off the whole bill
  const paidBill = async (extra = {}) => {
    const e = await eway([{ productId: cable.id, qty: 10, priceType: 'retail' }, { productId: panel.id, serials: ['P-1', 'P-2'], priceType: 'retail' }]);
    return billService.create(company, user, { design: design.id, ewayBills: [e.id], discount: 10, discountIsPercent: true, payment: paid(), ...extra });
  };
  const paymentHeld = async () => (await Payment.findOne({}).lean())?.amount ?? 0;

  test('returns part of a line: priced pro rata with its share of GST and discount, stock back, refund off the payment', async () => {
    const { bill } = await paidBill();
    const before = await paymentHeld();
    assert.equal(before, bill.total);
    const form = await returnableOf(company, bill.id);
    assert.deepEqual(form.lines.map((l) => [l.name, l.qtyLeft, l.serialsLeft.length]), [['DC cable', 10, 0], ['Panel 540 Wp', 2, 2]]);

    const note = await creditNoteService.create(company, user, bill.id, { lines: [{ line: 0, qty: 4 }], reason: 'Wrong length', refund: refund() });
    assert.equal(note.creditNo, 'CN-0001');
    // 4 of 10 m: 1000 × 90% = 900 → 360 taxable, 18% GST 64.80
    assert.deepEqual([note.lines[0].qty, note.lines[0].taxable, note.lines[0].gstAmount, note.lines[0].lineTotal], [4, 360, 64.8, 424.8]);
    assert.equal(note.total, 424.8);
    assert.equal(note.pricing.taxByHsn[0].gst, 64.8);
    assert.equal(note.refund.mode, 'upi');
    assert.equal((await Batch.findOne({ product: cable._id })).qtyRemaining, 94); // 100 − 10 + 4
    assert.equal(await paymentHeld(), Math.round((before - 424.8) * 100) / 100);
    const ledger = await billingService.get(company, design.id);
    assert.equal(ledger.paid, Math.round((before - 424.8) * 100) / 100); // every ledger drops it at once
    assert.equal(ledger.creditNotes.length, 1);
    assert.equal((await Bill.findById(bill.id)).creditedTotal, 424.8);
    assert.equal((await Bill.findById(bill.id)).status, 'paid'); // the bill itself is unchanged

    // the rest of the line: the exact remainder, so the two credit notes add up to the line as billed
    const rest = await creditNoteService.create(company, user, bill.id, { lines: [{ line: 0, qty: 6 }], reason: 'Rest too', refund: refund() });
    assert.deepEqual([rest.lines[0].taxable, rest.lines[0].gstAmount, rest.lines[0].lineTotal], [540, 97.2, 637.2]);
    assert.equal(Math.round((note.total + rest.total) * 100) / 100, 1062); // 900 + 18%
    await assert.rejects(creditNoteService.create(company, user, bill.id, { lines: [{ line: 0, qty: 1 }], reason: 'x', refund: refund() }), /Only 0/);
  });

  test('serialized goods come back by serial number, once each, and only while still sold', async () => {
    const { bill } = await paidBill();
    const note = await creditNoteService.create(company, user, bill.id, { lines: [{ line: 1, serials: ['P-1'] }], reason: 'Cracked glass', refund: refund() });
    assert.deepEqual(note.lines[0].serials, ['P-1']);
    assert.equal(note.lines[0].qty, 1);
    assert.equal((await SerialUnit.findOne({ serialNo: 'P-1' })).status, 'inStock');
    assert.equal((await SerialUnit.findOne({ serialNo: 'P-2' })).status, 'sold');
    assert.equal((await Batch.findOne({ product: panel._id })).qtyRemaining, 2); // 3 received − 2 sold + 1 back
    await assert.rejects(creditNoteService.create(company, user, bill.id, { lines: [{ line: 1, serials: ['P-1'] }], reason: 'again', refund: refund() }), /not on this bill or already returned/);
    await assert.rejects(creditNoteService.create(company, user, bill.id, { lines: [{ line: 1, serials: [] }], reason: 'x', refund: refund() }), /Choose the serial numbers/);

    await SerialUnit.updateOne({ serialNo: 'P-2' }, { $set: { status: 'installed' } });
    await assert.rejects(creditNoteService.create(company, user, bill.id, { lines: [{ line: 1, serials: ['P-2'] }], reason: 'x', refund: refund() }), /no longer sold/);
    assert.equal(await CreditNote.countDocuments(), 1); // the refused one changed nothing
  });

  test('a mistake in the request changes nothing: not goods, no reason, no refund mode, more than was billed', async () => {
    const svc = await billService.create(company, user, { design: design.id, services: [{ name: 'Wiring', qty: 1, rate: 500, gstPercent: 0 }], payment: paid() });
    const { bill } = await paidBill();
    await assert.rejects(creditNoteService.create(company, user, bill.id, { lines: [{ line: 7, qty: 1 }], reason: 'x', refund: refund() }), /Only the goods/);
    await assert.rejects(creditNoteService.create(company, user, bill.id, { lines: [{ line: 0, qty: 99 }], reason: 'x', refund: refund() }), /Only 10/);
    await assert.rejects(creditNoteService.create(company, user, bill.id, { lines: [{ line: 0, qty: 1 }], reason: '', refund: refund() }), /reason/);
    await assert.rejects(creditNoteService.create(company, user, bill.id, { lines: [{ line: 0, qty: 1 }], reason: 'x', refund: {} }), /how the money/);
    await assert.rejects(creditNoteService.create(company, user, svc.bill.id, { lines: [{ line: 0, qty: 1 }], reason: 'x', refund: refund() }), /Only the goods/); // a services-only bill has no goods
    assert.equal(await CreditNote.countDocuments(), 0);
    assert.equal((await Batch.findOne({ product: cable._id })).qtyRemaining, 90);
  });

  test('works on a bill that is already invoiced; the invoice stays as issued', async () => {
    const { bill } = await paidBill();
    const { createdInvoice } = await billingService.createInvoiceFromBills(company, user, { design: design.id });
    const note = await creditNoteService.create(company, user, bill.id, { lines: [{ line: 0, qty: 2 }], reason: 'Returned', refund: refund() });
    assert.equal(String(note.invoice), createdInvoice.id);
    const invoice = await Invoice.findById(createdInvoice.id);
    assert.equal(invoice.total, createdInvoice.total);
    assert.equal(invoice.status, 'issued');
    assert.equal((await Bill.findById(bill.id)).status, 'invoiced');
  });

  test('returning everything takes the whole payment off; a bill with a credit note can no longer be voided', async () => {
    const { bill } = await paidBill();
    await creditNoteService.create(company, user, bill.id, { lines: [{ line: 0, qty: 10 }, { line: 1, serials: ['P-1', 'P-2'] }], reason: 'Whole order back', refund: refund() });
    assert.equal(await Payment.countDocuments(), 0);
    const saved = await Bill.findById(bill.id);
    assert.equal(saved.creditedTotal, bill.total);
    assert.equal(saved.payment, null);
    assert.equal((await billingService.get(company, design.id)).paid, 0);
    await assert.rejects(billService.void(company, user, bill.id, { reason: 'x' }), /already been returned/);
  });

  test('a repeated request returns the same credit note and refunds once', async () => {
    const { bill } = await paidBill();
    const body = { lines: [{ line: 0, qty: 3 }], reason: 'Wrong length', refund: refund(), idempotencyKey: 'key-credit-001' };
    const first = await creditNoteService.create(company, user, bill.id, body);
    const again = await creditNoteService.create(company, user, bill.id, body);
    assert.equal(again.id, first.id);
    assert.equal(await CreditNote.countDocuments(), 1);
    assert.equal((await Batch.findOne({ product: cable._id })).qtyRemaining, 93);
  });
});

// The optional reference & delivery details on an invoice: cleaned, stored, and empty when nothing was entered.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Client, Company, Design, Invoice } from '../src/models/index.js';
import { billingService, cleanInvoiceDetails } from '../src/services/billing.service.js';

let replSet;
let company;
const user = { _id: new mongoose.Types.ObjectId(), name: 'Owner', role: 'company' };
const direct = (extra = {}) => billingService.createDirectInvoice(company, user, {
  billTo: { name: 'Walk-in customer' },
  pricing: { lines: [{ name: 'Service', qty: 1, rate: 1000, gstPercent: 18 }], gstIncluded: false, withGst: true, invoiceGstMode: 'with_gst' },
  ...extra,
});

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
  await Invoice.init();
});
after(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  await Invoice.syncIndexes();
  company = await Company.create({ name: 'Acme Solar' });
});

test('details are trimmed, limited to the known fields and dropped when empty', () => {
  assert.equal(cleanInvoiceDetails(undefined), null);
  assert.equal(cleanInvoiceDetails({ reference: '   ', destination: '' }), null);
  assert.deepEqual(cleanInvoiceDetails({ reference: ' REF-1 / 2 Oct ', buyerOrderNo: 'PO-77', bogus: 'x', termsOfDelivery: 'a'.repeat(400) }).termsOfDelivery.length, 300);
  assert.deepEqual(cleanInvoiceDetails({ reference: ' REF-1 ', bogus: 'x' }), { reference: 'REF-1' });
});

test('an invoice keeps the details that were entered, and none when none were', async () => {
  const none = (await direct()).createdInvoice;
  assert.equal(none.details ?? null, null);
  const full = {
    reference: 'REF-9 / 1 Oct 2026', otherReferences: 'Tender 12', buyerOrderNo: 'PO-77', buyerOrderDate: '2026-09-28',
    dispatchDocNo: 'DD-4', deliveryNoteDate: '2026-10-02', dispatchedThrough: 'Blue Dart', destination: 'Nashik', termsOfDelivery: 'Delivered to site',
  };
  const res = (await direct({ details: full })).createdInvoice;
  assert.deepEqual(res.details, full);
  assert.deepEqual((await Invoice.findById(res.id)).toJSON().details, full);
});

test('a direct invoice keeps the buyer’s company name when given', async () => {
  const res = (await direct({ billTo: { name: 'Sunil Patil', company: '  Patil Industries Pvt Ltd ' } })).createdInvoice;
  assert.equal(res.billTo.company, 'Patil Industries Pvt Ltd');
  assert.equal(res.billTo.name, 'Sunil Patil');
  assert.equal((await direct()).createdInvoice.billTo.company, ''); // optional
});

test('an invoice on a proposal keeps the company name and details, and the next one is pre-filled from it', async () => {
  const client = await Client.create({ company: company._id, name: 'Sunil Patil' });
  const pricing = { lines: [{ name: 'Rooftop system', qty: 1, rate: 100000, gstPercent: 12 }], gstIncluded: false, withGst: true, invoiceGstMode: 'with_gst', total: 112000 };
  const design = await Design.create({ company: company._id, client: client._id, name: 'Patil bungalow', status: 'won', summary: { pricing, cost: 112000 } });
  const first = await billingService.createInvoice(company, user, design.id, { billToCompany: ' Patil Industries ', details: { buyerOrderNo: 'PO-5' } });
  assert.equal(first.createdInvoice.billToCompany, 'Patil Industries');
  assert.equal(first.createdInvoice.details.buyerOrderNo, 'PO-5');
  assert.equal(first.createdInvoice.billTo ?? null, null); // the buyer is still the client record
  const form = await billingService.get(company, design.id);
  assert.equal(form.previousBillToCompany, 'Patil Industries');
  const second = await billingService.createInvoice(company, user, design.id, {});
  assert.equal(second.createdInvoice.billToCompany ?? '', '');
});

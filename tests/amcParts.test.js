// Parts replaced on an AMC visit, invoiced to the client from stock — against an in-memory replica set, since the
// invoice and the stock deduction happen in one transaction.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Batch, Category, Client, Company, Design, Invoice, Product, Project, SerialUnit, Supplier } from '../src/models/index.js';
import { markAmcPartsInvoices } from '../src/migrations/invoiceKind.migration.js';
import { billingService } from '../src/services/billing.service.js';
import { getAmcPartsInvoice, getAmcPartsInvoiceAsAgent, invoiceAmcParts, invoiceAmcPartsAsAgent } from '../src/services/project.service.js';
import { receiveStock } from '../src/services/stock.service.js';

let replSet;
let company;
let product;
let project;
const owner = { _id: new mongoose.Types.ObjectId(), name: 'Owner', role: 'company' };
const agentId = new mongoose.Types.ObjectId();
const agent = { _id: agentId, id: String(agentId), name: 'Farah', role: 'agent' };
const visitId = () => project.amcVisits[0].id;

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
  await Promise.all([Batch, Invoice, SerialUnit, Company].map((M) => M.init()));
});

after(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  await Promise.all([Batch, Invoice, SerialUnit].map((M) => M.syncIndexes()));
  company = await Company.create({ name: 'Acme Solar' });
  agent.company = company._id;
  const supplier = await Supplier.create({ company: company._id, name: 'Sunrise' });
  const category = await Category.create({ company: company._id, name: 'Protection' });
  product = await Product.create({ company: company._id, category: category._id, name: 'DC fuse 15 A', unit: 'Nos', gstPercent: 18 });
  await receiveStock(company, product._id, { supplier: supplier.id, qtyReceived: 10, basePrice: 80, wholesalePrice: 90, retailPrice: 120, purchasePrice: 60 });
  const client = await Client.create({ company: company._id, name: 'Sunil Patil' });
  const design = await Design.create({ company: company._id, client: client._id, name: 'Patil bungalow – 8 kW', status: 'won' });
  project = await Project.create({
    company: company._id,
    design: design._id,
    client: client._id,
    status: 'completed',
    amcVisits: [{ name: 'AMC1', kind: 'mandatory', price: 0, assignee: agentId, assigneeName: 'Farah', workflowStatus: 'assigned' }],
  });
});

test('parts are invoiced on the proposal, taken from stock and recorded on the visit', async () => {
  const res = await invoiceAmcParts(company, owner, project.id, visitId(), { lines: [{ productId: product.id, qty: 2, priceType: 'retail' }], withGst: true, note: 'Blown fuses' });
  assert.equal(res.client.name, 'Sunil Patil');
  assert.equal(res.invoice.title, 'AMC1 — parts used · Patil bungalow – 8 kW');
  assert.equal(res.invoice.pricing.lines.length, 1);
  assert.equal(res.invoice.pricing.lines[0].rate, 120);
  assert.equal(res.invoice.total, 283.2); // 2 × 120 + 18% GST

  const batch = await Batch.findOne({ product: product._id });
  assert.equal(batch.qtyRemaining, 8);
  const saved = await Project.findById(project._id);
  const visit = saved.amcVisits[0];
  assert.equal(visit.partsInvoiceNo, res.invoice.invoiceNo);
  assert.deepEqual(visit.parts.map((p) => [p.productName, p.qty, p.rate]), [['DC fuse 15 A', 2, 120]]);
  assert.equal(saved.logs.at(-1).action, 'amc_parts_invoiced');
  assert.match(saved.logs.at(-1).message, /Blown fuses/);
  assert.equal(String((await Invoice.findById(res.invoice.id)).design), String(project.design));
});

test('a visit is invoiced once; the invoice can be read back for its PDF', async () => {
  await invoiceAmcParts(company, owner, project.id, visitId(), { lines: [{ productId: product.id, qty: 1 }] });
  await assert.rejects(invoiceAmcParts(company, owner, project.id, visitId(), { lines: [{ productId: product.id, qty: 1 }] }), /already invoiced/);
  const again = await getAmcPartsInvoice(company, project.id, visitId());
  assert.equal(again.invoice.pricing.lines[0].rate, 120); // retail by default
  assert.equal(again.design.name, 'Patil bungalow – 8 kW');
});

test('the assigned technician can invoice; someone else’s visit is refused; stock is never oversold', async () => {
  const other = { ...agent, _id: new mongoose.Types.ObjectId(), id: 'x' };
  await assert.rejects(invoiceAmcPartsAsAgent(other, project.id, visitId(), { lines: [{ productId: product.id, qty: 1 }] }), /not found/i);
  await assert.rejects(invoiceAmcPartsAsAgent(agent, project.id, visitId(), { lines: [{ productId: product.id, qty: 11 }] }));
  assert.equal(await Invoice.countDocuments(), 0);
  const res = await invoiceAmcPartsAsAgent(agent, project.id, visitId(), { lines: [{ productId: product.id, qty: 3, priceType: 'wholesale' }], withGst: false });
  assert.equal(res.invoice.total, 270);
  assert.equal(res.invoice.createdByName, 'Farah');
  assert.equal((await Batch.findOne({ product: product._id })).qtyRemaining, 7);
});

test('on their own side, staff only handle the parts of a visit assigned to them, even on an installation they work on', async () => {
  // a second, unassigned visit on the same installation, where Farah holds the first one
  project.amcVisits.push({ name: 'AMC2', kind: 'mandatory', price: 0, });
  await project.save();
  const unassigned = project.amcVisits[1].id;
  await assert.rejects(invoiceAmcPartsAsAgent(agent, project.id, unassigned, { lines: [{ productId: product.id, qty: 1 }] }), /not assigned to you/);
  assert.equal(await Invoice.countDocuments(), 0);

  await invoiceAmcParts(company, owner, project.id, unassigned, { lines: [{ productId: product.id, qty: 1 }] }); // the company can
  await assert.rejects(getAmcPartsInvoiceAsAgent(agent, project.id, unassigned), /not assigned to you/);
  await invoiceAmcPartsAsAgent(agent, project.id, visitId(), { lines: [{ productId: product.id, qty: 1 }] });
  assert.equal((await getAmcPartsInvoiceAsAgent(agent, project.id, visitId())).visit.name, 'AMC1');
});

const fuses = (qty = 2) => ({ lines: [{ productId: product.id, qty, priceType: 'retail' }], withGst: true });

test('an AMC parts invoice is its own kind: it is not the proposal’s invoice and does not hide a missing sale invoice', async () => {
  await Design.updateOne({ _id: project.design }, { $set: { summary: { pricing: { total: 100000 }, cost: 100000 } } }); // a priced, booked proposal
  await invoiceAmcParts(company, owner, project.id, visitId(), fuses());
  const invoice = await Invoice.findOne();
  assert.equal(invoice.kind, 'amc_parts');
  const ledger = await billingService.get(company, project.design);
  assert.equal(ledger.invoice, null); // not the proposal's invoice
  assert.equal(ledger.invoices.length, 1); // but it is listed
  const overview = await billingService.overview(company);
  assert.equal(overview[0].invoiceNo, '');
  const { dashboard } = await import('../src/services/dashboard.service.js');
  assert.equal((await dashboard(company)).attention.invoice.length, 1); // the booked proposal still has no sale invoice
});

test('the invoice, the stock and the visit are one commit: nothing is kept when recording it on the visit fails', async () => {
  const original = Project.updateOne;
  Project.updateOne = async () => ({ modifiedCount: 0 }); // the visit was invoiced by someone else a moment ago
  try {
    await assert.rejects(invoiceAmcParts(company, owner, project.id, visitId(), fuses(3)), /just invoiced/);
  } finally {
    Project.updateOne = original;
  }
  assert.equal(await Invoice.countDocuments(), 0); // the invoice was rolled back
  assert.equal((await Batch.findOne({ product: product._id })).qtyRemaining, 10); // and so was the stock deduction
  const saved = await Project.findById(project.id);
  assert.equal(saved.logs.filter((l) => l.action === 'amc_parts_invoiced').length, 0);
  assert.equal(saved.amcVisits[0].partsInvoice, null);
  // a later attempt works and numbers the invoice from the start
  const res = await invoiceAmcParts(company, owner, project.id, visitId(), fuses(3));
  assert.equal(res.invoice.invoiceNo, 'INV-0001');
  assert.equal((await Batch.findOne({ product: product._id })).qtyRemaining, 7);
});

test('two requests for the same visit at the same moment invoice it once and take the stock once', async () => {
  const run = () => invoiceAmcParts(company, owner, project.id, visitId(), fuses(2));
  const results = await Promise.allSettled([run(), run()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await Invoice.countDocuments(), 1);
  assert.equal((await Batch.findOne({ product: product._id })).qtyRemaining, 8);
});

test('the migration marks the AMC parts invoices issued before kinds existed, and leaves sale invoices alone', async () => {
  await invoiceAmcParts(company, owner, project.id, visitId(), fuses());
  const sale = await Invoice.create({ company: company._id, design: project.design, client: project.client, invoiceNo: 'INV-SALE', total: 5 });
  await Invoice.collection.updateMany({}, { $unset: { kind: '' } }); // as they were stored before
  await markAmcPartsInvoices();
  assert.equal((await Invoice.findOne({ invoiceNo: sale.invoiceNo })).kind, 'sale');
  const partsInvoice = await Invoice.collection.findOne({ _id: (await Project.findById(project.id)).amcVisits[0].partsInvoice });
  assert.equal(partsInvoice.kind, 'amc_parts');
  await markAmcPartsInvoices(); // running it again changes nothing
});

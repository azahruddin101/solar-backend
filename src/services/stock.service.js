// Stock: batches (one per receipt), the serial units of serialized products, and taking stock out.
//
// Every change to `qtyRemaining` is one atomic update with a `$gte` guard, so two sales at the same moment can never
// take the same items; selling and invoicing (billing.service.js) or issuing to an installation (project.service.js)
// run in one MongoDB transaction with the deduction (`inTransaction`). Transactions need a replica set — Atlas always
// is one; a local mongod must be started with --replSet (see backend/.env.example).
import mongoose from 'mongoose';
import { PRICE_TYPES, UNIT_TRANSITIONS } from '../constants/index.js';
import { Batch, Invoice, Product, Project, SerialUnit, Supplier } from '../models/index.js';
import { warrantyEndDate } from '../models/serialUnit.model.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import { deleteFile } from './storage.service.js';
import { parsePagination, toApiJSON, toApiJSONList } from '../utils/lean.js';
import { pick } from '../utils/pick.js';
import { objectId } from '../utils/validators.js';

export const PRICE_FIELD = { base: 'basePrice', wholesale: 'wholesalePrice', retail: 'retailPrice' };
const UNIT_LABEL = { inStock: 'in stock', sold: 'sold', installed: 'installed', returned: 'returned' };
const MAX_SERIALS = 2000;
const BATCH_FIELDS = ['batchNo', 'mfgDate', 'mfgYear', 'receivedDate', 'purchasePrice', 'basePrice', 'wholesalePrice', 'retailPrice', 'note'];

/** Run `fn(session)` in a transaction (retried on transient errors such as two sales touching the same batch). */
export const inTransaction = (fn) => mongoose.connection.transaction(fn);

async function ownProduct(company, id, session = null) {
  const product = await Product.findOne({ _id: objectId(id, 'Product'), company: company._id }).session(session);
  if (!product) throw notFound('Product');
  return product;
}

async function ownSupplier(company, id, session = null) {
  if (!id) throw badRequest('Choose the supplier');
  const supplier = await Supplier.findOne({ _id: objectId(id, 'Supplier'), company: company._id }).select('_id').session(session);
  if (!supplier) throw notFound('Supplier');
  return supplier;
}

/** Serial numbers as typed: trimmed, blanks dropped, a repeat is an error. */
export function cleanSerials(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw badRequest('Invalid serial numbers');
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (s.length > 80) throw badRequest(`Serial number “${s.slice(0, 20)}…” is too long`);
    if (seen.has(s.toLowerCase())) throw badRequest(`Serial number ${s} is listed twice`);
    seen.add(s.toLowerCase());
    out.push(s);
  }
  if (out.length > MAX_SERIALS) throw badRequest(`Up to ${MAX_SERIALS} serial numbers at a time`);
  return out;
}

/** The dates and prices of a batch from the form; prices must be numbers ≥ 0 (the schema enforces "required"). */
function batchFields(body) {
  const data = pick(body, BATCH_FIELDS);
  for (const k of ['purchasePrice', 'basePrice', 'wholesalePrice', 'retailPrice']) {
    if (data[k] === undefined || data[k] === null || data[k] === '') {
      delete data[k];
      continue;
    }
    const n = Number(data[k]);
    if (!Number.isFinite(n) || n < 0) throw badRequest('Prices must be 0 or more');
    data[k] = n;
  }
  for (const k of ['mfgDate', 'receivedDate']) {
    if (data[k] === '' || data[k] === null) data[k] = k === 'mfgDate' ? null : undefined;
    else if (data[k] !== undefined && Number.isNaN(new Date(data[k]).getTime())) throw badRequest('Invalid date');
  }
  if (data.mfgYear === '') data.mfgYear = null;
  return data;
}

/* ───────────── receiving ───────────── */

/**
 * Receive stock of a product: one new batch, and for a serialized product one SerialUnit per serial number
 * (the quantity is then the number of serials).
 */
export async function receiveStock(company, productId, body = {}) {
  return inTransaction(async (session) => {
    const product = await ownProduct(company, productId, session);
    const supplier = await ownSupplier(company, body.supplier, session);
    const serials = product.isSerialized ? cleanSerials(body.serials) : [];
    let qty = Number(body.qtyReceived);
    if (product.isSerialized) {
      if (!serials.length) throw badRequest(`${product.name} is tracked by serial number: enter the serial number of every item received`);
      if (body.qtyReceived != null && body.qtyReceived !== '' && qty !== serials.length) throw badRequest(`Quantity is ${qty} but ${serials.length} serial numbers were entered`);
      qty = serials.length;
      const taken = await SerialUnit.find({ company: company._id, serialNo: { $in: serials } }).select('serialNo').session(session).lean();
      if (taken.length) throw conflict(`Already received: ${taken.map((u) => u.serialNo).slice(0, 10).join(', ')}`);
    }
    if (!(qty > 0)) throw badRequest('Enter the quantity received');
    const [batch] = await Batch.create([{ ...batchFields(body), company: company._id, product: product._id, supplier: supplier._id, qtyReceived: qty, qtyRemaining: qty }], { session });
    if (serials.length) await SerialUnit.insertMany(serials.map((serialNo) => ({ company: company._id, product: product._id, batch: batch._id, serialNo })), { session });
    return batch;
  });
}

/** Keeps the supplier's bill (already stored by uploadStockBill) with a batch; a bill uploaded before is replaced. */
export async function attachBatchBill(company, batchId, file) {
  if (!file?.filename) throw badRequest('Choose the bill to upload (PDF or image)');
  let batch;
  try {
    batch = await Batch.findOne({ _id: objectId(batchId, 'Batch'), company: company._id });
    if (!batch) throw notFound('Batch');
  } catch (e) {
    await deleteFile(file.filename).catch(() => {});
    throw e;
  }
  const old = batch.billUrl;
  batch.billUrl = `/uploads/${file.filename}`;
  batch.billName = String(file.originalname || 'Bill').slice(0, 200);
  await batch.save();
  if (old) await deleteFile(old.replace(/^\/uploads\//, '')).catch(() => {});
  return toApiJSON(batch.toObject());
}

/** Correct a batch's details and prices. Quantities change only by receiving, selling and issuing. */
export async function updateBatch(company, id, body = {}) {
  const batch = await Batch.findOne({ _id: objectId(id, 'Batch'), company: company._id });
  if (!batch) throw notFound('Batch');
  Object.assign(batch, batchFields(body));
  if (body.supplier !== undefined) batch.supplier = (await ownSupplier(company, body.supplier))._id;
  await batch.save();
  return batch;
}

/* ───────────── taking stock out ───────────── */

/** `-n` from one batch, only if it still has `n` (the guard that stops overselling). */
async function takeFromBatch(company, product, batchId, n, session) {
  const updated = await Batch.findOneAndUpdate(
    { _id: batchId, company: company._id, product: product._id, qtyRemaining: { $gte: n } },
    { $inc: { qtyRemaining: -n } },
    { session, returnDocument: 'after' },
  ).lean();
  if (updated) return updated;
  const batch = await Batch.findOne({ _id: batchId, company: company._id, product: product._id }).select('qtyRemaining batchNo').session(session).lean();
  if (!batch) throw notFound('Batch');
  throw conflict(`${batch.batchNo ? `Batch ${batch.batchNo}` : 'This batch'} of ${product.name} has only ${batch.qtyRemaining} ${product.unit} left`);
}

/**
 * Take items of `product` out of stock inside `session`:
 * - serialized: exactly the units with these serial numbers (they must be in stock), moved to `unitUpdate.status`;
 * - otherwise `qty` from the chosen `batch`, or oldest batches first (FIFO by receivedDate).
 * Returns one allocation per batch used: [{ batch (lean, after the update), qty, serials }].
 */
export async function deductStock(company, product, { qty, batch, serials } = {}, session, unitUpdate = {}) {
  if (!session) throw new Error('deductStock must run inside a transaction');
  if (product.isSerialized) {
    const wanted = cleanSerials(serials);
    if (!wanted.length) throw badRequest(`Choose the serial numbers of ${product.name}`);
    if (qty != null && qty !== '' && Number(qty) !== wanted.length) throw badRequest(`Quantity of ${product.name} is ${qty} but ${wanted.length} serial numbers were chosen`);
    const units = await SerialUnit.find({ company: company._id, product: product._id, serialNo: { $in: wanted }, status: 'inStock' }).session(session).lean();
    if (units.length !== wanted.length) {
      const found = new Set(units.map((u) => u.serialNo));
      throw conflict(`Not in stock: ${wanted.filter((s) => !found.has(s)).slice(0, 10).join(', ')}`);
    }
    const moved = await SerialUnit.updateMany({ _id: { $in: units.map((u) => u._id) }, status: 'inStock' }, { $set: unitUpdate }, { session });
    if (moved.modifiedCount !== units.length) throw conflict('Some of these units were just sold. Refresh and try again');
    const byBatch = new Map();
    for (const u of units) byBatch.set(String(u.batch), [...(byBatch.get(String(u.batch)) || []), u.serialNo]);
    const out = [];
    for (const [batchId, list] of byBatch) out.push({ batch: await takeFromBatch(company, product, batchId, list.length, session), qty: list.length, serials: list });
    return out;
  }

  const need = Number(qty);
  if (!(need > 0)) throw badRequest(`Enter the quantity of ${product.name}`);
  if (batch) return [{ batch: await takeFromBatch(company, product, objectId(batch, 'Batch'), need, session), qty: need, serials: [] }];

  const batches = await Batch.find({ company: company._id, product: product._id, qtyRemaining: { $gt: 0 } }).sort({ receivedDate: 1, _id: 1 }).session(session).lean();
  const available = batches.reduce((a, b) => a + b.qtyRemaining, 0);
  if (available < need) throw conflict(`Only ${available} ${product.unit} of ${product.name} in stock`);
  const out = [];
  let left = need;
  for (const b of batches) {
    if (!left) break;
    const take = Math.min(left, b.qtyRemaining);
    out.push({ batch: await takeFromBatch(company, product, b._id, take, session), qty: take, serials: [] });
    left -= take;
  }
  return out;
}

/**
 * Invoice lines → stored lines. A line with a `productId` takes its stock now (FIFO, a chosen batch, or chosen serials)
 * and is priced from the batch at the chosen price type; it becomes one line per batch used, carrying copies of the
 * batch number, serials, price type and rate, so editing the batch later never changes the invoice. Lines without
 * a product (labour, charges…) pass through unchanged.
 */
export async function allocateInvoiceLines(company, lines, { invoiceId, session }) {
  const out = [];
  for (const line of lines || []) {
    if (!line?.productId) {
      out.push(line);
      continue;
    }
    const product = await ownProduct(company, line.productId, session);
    if (!PRICE_TYPES.includes(line.priceType)) throw badRequest(`Choose the base, wholesale or retail price for ${product.name}`);
    const allocations = await deductStock(company, product, line, session, { status: 'sold', soldInvoice: invoiceId });
    for (const a of allocations) {
      out.push({
        ...line,
        name: String(line.name || '').trim() || product.name,
        detail: line.detail || '', // serial numbers travel in `serials`; the PDF prints them
        hsn: line.hsn || product.hsnCode,
        unit: line.unit || product.unit,
        gstPercent: line.gstPercent ?? product.gstPercent,
        productId: String(product._id),
        batch: String(a.batch._id),
        batchNo: a.batch.batchNo || '',
        serials: a.serials,
        priceType: line.priceType,
        qty: a.qty,
        rate: a.batch[PRICE_FIELD[line.priceType]],
      });
    }
  }
  return out;
}

/* ───────────── serial units ───────────── */

/** Throws unless a unit may move from `from` to `to` (constants UNIT_TRANSITIONS). */
export function assertTransition(from, to) {
  if (!UNIT_TRANSITIONS[from]?.includes(to)) throw badRequest(`A unit that is ${UNIT_LABEL[from] || from} can't be marked ${UNIT_LABEL[to] || to}`);
}

/**
 * Change a unit's status by hand. Selling and issuing to an installation take units out of stock through invoices
 * and installations, so here only: sold → installed (at an installation), sold/installed → returned, and
 * returned → in stock (back into its batch).
 */
export async function setUnitStatus(company, unitId, body = {}) {
  const to = body.status;
  return inTransaction(async (session) => {
    const unit = await SerialUnit.findOne({ _id: objectId(unitId, 'Unit'), company: company._id }).session(session);
    if (!unit) throw notFound('Unit');
    assertTransition(unit.status, to);
    if (unit.status === 'inStock') throw badRequest('Sell it on an invoice instead');
    const set = { status: to };
    if (to === 'installed') {
      const project = await Project.findOne({ _id: objectId(body.project, 'Installation'), company: company._id }).select('_id').session(session);
      if (!project) throw notFound('Installation');
      const installDate = body.installDate ? new Date(body.installDate) : new Date();
      if (Number.isNaN(installDate.getTime())) throw badRequest('Invalid install date');
      Object.assign(set, { installedProject: project._id, installDate });
    }
    if (to === 'inStock') Object.assign(set, { soldInvoice: null, installedProject: null, installDate: null });
    const updated = await SerialUnit.findOneAndUpdate({ _id: unit._id, status: unit.status }, { $set: set }, { session, returnDocument: 'after' });
    if (!updated) throw conflict('This unit was just changed. Refresh and try again');
    if (to === 'inStock') await Batch.updateOne({ _id: unit.batch }, { $inc: { qtyRemaining: 1 } }, { session });
    return updated;
  });
}

/* ───────────── reading ───────────── */

/**
 * Stock on hand and the current selling price of each product: the retail price of the oldest batch that still has
 * stock (the one FIFO sells next), else of the newest batch, else 0 — and that batch's manufacture year.
 * Map of productId → { stock, price, mfgYear }.
 */
export async function stockSummary(companyId, productIds = null) {
  const match = { company: companyId, ...(productIds ? { product: { $in: productIds } } : {}) };
  const batches = await Batch.find(match).select('product qtyRemaining retailPrice mfgYear mfgDate').sort({ receivedDate: 1, _id: 1 }).lean();
  const out = new Map();
  for (const b of batches) {
    const k = String(b.product);
    const s = out.get(k) || { stock: 0, price: 0, inStockPriced: false };
    s.stock += b.qtyRemaining;
    if (!s.inStockPriced) {
      s.price = b.retailPrice; // ascending order: ends on the newest batch unless one with stock comes first
      s.mfgYear = b.mfgYear ?? (b.mfgDate ? new Date(b.mfgDate).getFullYear() : null);
      s.inStockPriced = b.qtyRemaining > 0;
    }
    out.set(k, s);
  }
  return new Map([...out].map(([k, { stock, price, mfgYear }]) => [k, { stock, price, mfgYear }]));
}

/** A product's batches, newest first, with the supplier's name. */
export async function listBatches(company, productId, { inStock } = {}) {
  const product = await ownProduct(company, productId);
  const rows = await Batch.find({ company: company._id, product: product._id, ...(inStock ? { qtyRemaining: { $gt: 0 } } : {}) })
    .sort(inStock ? { receivedDate: 1, _id: 1 } : { receivedDate: -1, _id: -1 })
    .populate('supplier', 'name')
    .lean();
  return toApiJSONList(rows);
}

const unitJSON = (u, warrantyMonths) => ({ ...toApiJSON(u), warrantyEnd: warrantyEndDate(u.installDate, warrantyMonths) });

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A serialized product's units (optionally of one status, or whose serial number contains `q`), with their batch
 * number and warranty end. With `page` it returns one page, { items, total, page, limit } (limit up to 100);
 * without it every unit (the pickers on invoices and installations need the full in-stock list).
 */
export async function listUnits(company, productId, { status, q, page, limit } = {}) {
  const product = await ownProduct(company, productId);
  const search = String(q ?? '').trim();
  const filter = { company: company._id, product: product._id, ...(status ? { status } : {}), ...(search ? { serialNo: { $regex: escapeRe(search), $options: 'i' } } : {}) };
  const query = (skip, max) => {
    const find = SerialUnit.find(filter).sort({ createdAt: 1, serialNo: 1, _id: 1 });
    if (max) find.skip(skip).limit(max);
    return find
      .populate('batch', 'batchNo receivedDate')
      .populate({ path: 'installedProject', select: 'design', populate: { path: 'design', select: 'name' } })
      .lean()
      .then((rows) => rows.map((u) => unitJSON(u, product.warrantyMonths)));
  };
  if (page === undefined) return query(0, 0);
  const p = parsePagination({ page, limit }, { defaultLimit: 10, maxLimit: 100 });
  const [items, total] = await Promise.all([query(p.skip, p.limit), SerialUnit.countDocuments(filter)]);
  return { items, total, page: p.page, limit: p.limit };
}

/** Look a unit up by its serial number: where it is, which invoice sold it, and when its warranty ends. */
export async function findUnit(company, serialNo) {
  const serial = String(serialNo ?? '').trim();
  if (!serial) throw badRequest('Enter a serial number');
  const unit = await SerialUnit.findOne({ company: company._id, serialNo: serial })
    .populate('product', 'name brand model warrantyMonths')
    .populate('batch', 'batchNo receivedDate')
    .populate({ path: 'installedProject', select: 'design client', populate: [{ path: 'design', select: 'name' }, { path: 'client', select: 'name' }] })
    .lean();
  if (!unit) throw notFound('Unit');
  const invoice = unit.soldInvoice ? await Invoice.findById(unit.soldInvoice).select('invoiceNo issuedOn').lean() : null;
  return { ...unitJSON(unit, unit.product?.warrantyMonths), soldInvoice: toApiJSON(invoice) };
}

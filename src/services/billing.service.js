// Receipts and tax invoices for booked proposals (each invoice generation is stored separately).
import mongoose from 'mongoose';
import { Batch, Client, Counter, Design, Invoice, Payment, Product, Project } from '../models/index.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import { parsePagination, toApiJSON, toApiJSONList } from '../utils/lean.js';
import { dateRangeOnField } from '../utils/listFilters.js';
import { cleanRichText } from '../utils/richText.js';
import { objectId } from '../utils/validators.js';
import { createNumberedInvoice, peekInvoiceNo } from './invoiceNumber.service.js';
import { authorityInvoicePricing, resolveInvoicePricing } from './invoicePricing.service.js';
import { revokeSharesForPdf } from './fileShare.service.js';
import { deleteFile } from './storage.service.js';
import { allocateInvoiceLines, inTransaction } from './stock.service.js';

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function nextNumber(company, key, prefix) {
  const c = await Counter.findOneAndUpdate({ company: company._id, key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return `${prefix}-${String(c.seq).padStart(4, '0')}`;
}

async function getDesign(company, id) {
  const design = await Design.findOne({ _id: objectId(id, 'Proposal'), company: company._id }).populate('client');
  if (!design) throw notFound('Proposal');
  return design;
}

/** What the client owes for a proposal: the saved grand total. */
export const totalOf = (design) => money(design.summary?.pricing?.total ?? design.summary?.cost);

async function ledger(company, design) {
  const payments = await Payment.find({ company: company._id, design: design._id }).sort({ createdAt: 1 }).lean();
  const invoices = await Invoice.find({ company: company._id, design: design._id }).sort({ createdAt: -1 }).lean();
  const total = totalOf(design);
  const paid = money(payments.reduce((a, p) => a + p.amount, 0));
  const invoiceRows = toApiJSONList(invoices);
  return {
    design: {
      id: design.id,
      name: design.name,
      status: design.status,
      type: design.type,
      pricing: design.summary?.pricing || null,
      quote: design.data?.quote || null,
      client: design.client,
    },
    total,
    paid,
    balance: money(total - paid),
    payments: toApiJSONList(payments),
    invoices: invoiceRows,
    invoice: invoiceRows[0] || null,
  };
}

const DETAIL_FIELDS = { reference: 120, otherReferences: 120, buyerOrderNo: 80, buyerOrderDate: 20, dispatchDocNo: 80, deliveryNoteDate: 20, dispatchedThrough: 120, destination: 120, termsOfDelivery: 300 };

/** The optional reference & delivery details of an invoice: known fields only, trimmed; null when none were filled in. */
export function cleanInvoiceDetails(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const [key, max] of Object.entries(DETAIL_FIELDS)) {
    const v = String(input[key] ?? '').trim().slice(0, max);
    if (v) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Creates the invoice and takes the stock of its product lines in one transaction: either both happen or neither.
 * `pricingFor(lines)` turns the stock-allocated lines into the stored pricing (totals recomputed on the server).
 */
async function issueInvoice(company, inputLines, pricingFor, fields) {
  return inTransaction(async (session) => {
    const invoiceId = new mongoose.Types.ObjectId(); // the sold units point at it
    const lines = await allocateInvoiceLines(company, inputLines, { invoiceId, session });
    const pricing = pricingFor(lines);
    return createNumberedInvoice(company, { _id: invoiceId, ...fields, total: money(pricing.total), pricing }, { session });
  });
}

/**
 * Stores the PDF of an issued invoice or receipt — once. The archived PDF is the document the client was given, so it
 * is never replaced or deleted afterwards (a second upload is refused and its file removed). The check and the write
 * are one atomic update, so two uploads at the same moment can't both win.
 */
async function archivePdfOnce(Model, what, company, id, pdfName) {
  let filter;
  try {
    filter = { _id: objectId(id, what), company: company._id };
  } catch (e) {
    await deleteFile(pdfName).catch(() => {});
    throw e;
  }
  const stored = await Model.findOneAndUpdate(
    { ...filter, $or: [{ pdfName: '' }, { pdfName: null }, { pdfName: { $exists: false } }] },
    { $set: { pdfName } },
    { new: true },
  );
  if (stored) return { ok: true, pdfName };
  await deleteFile(pdfName).catch(() => {});
  if (!(await Model.exists(filter))) throw notFound(what);
  throw conflict(`This ${what.toLowerCase()} already has its PDF archived. Issued documents can't be replaced.`);
}

export const billingService = {
  /** Every won proposal with what has been received so far. */
  async overview(company, { from, to } = {}) {
    const match = { company: company._id, status: 'won', ...(dateRangeOnField('createdAt', from, to) || {}) };
    const designs = await Design.find(match).select('-data').populate('client', 'name phone email').sort({ updatedAt: -1 });
    const sums = await Payment.aggregate([{ $match: { company: company._id, design: { $in: designs.map((d) => d._id) } } }, { $group: { _id: '$design', paid: { $sum: '$amount' }, count: { $sum: 1 } } }]);
    const invoices = await Invoice.find({ company: company._id, design: { $in: designs.map((d) => d._id) } }).select('design invoiceNo createdAt').sort({ createdAt: -1 });
    const latestInv = new Map();
    for (const inv of invoices) {
      const k = String(inv.design);
      if (!latestInv.has(k)) latestInv.set(k, inv);
    }
    return designs.map((d) => {
      const s = sums.find((x) => String(x._id) === String(d._id));
      const total = totalOf(d);
      const paid = money(s?.paid);
      const inv = latestInv.get(String(d._id));
      return { id: d.id, name: d.name, type: d.type, client: d.client, total, paid, balance: money(total - paid), receipts: s?.count || 0, invoiceNo: inv?.invoiceNo || '' };
    });
  },

  async listPayments(company, { page, limit, from, to } = {}) {
    const match = { company: company._id, ...(dateRangeOnField('receivedOn', from, to) || {}) };
    const { page: p, limit: l, skip } = parsePagination({ page, limit });
    const [facet] = await Payment.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: 'clients',
          localField: 'client',
          foreignField: '_id',
          as: 'client',
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      { $unwind: { path: '$client', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'designs',
          localField: 'design',
          foreignField: '_id',
          as: 'design',
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      { $unwind: { path: '$design', preserveNullAndEmptyArrays: true } },
      {
        $facet: {
          meta: [{ $count: 'total' }],
          rows: [{ $skip: skip }, { $limit: l }],
        },
      },
    ]);
    const total = facet?.meta?.[0]?.total ?? 0;
    return { items: toApiJSONList(facet?.rows ?? []), total, page: p, limit: l };
  },
  async listInvoices(company, { page, limit, from, to } = {}) {
    const match = { company: company._id, ...(dateRangeOnField('issuedOn', from, to) || {}) };
    const { page: p, limit: l, skip } = parsePagination({ page, limit });
    const [facet] = await Invoice.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: 'clients',
          localField: 'client',
          foreignField: '_id',
          as: 'client',
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      { $unwind: { path: '$client', preserveNullAndEmptyArrays: true } },
      {
        $facet: {
          meta: [{ $count: 'total' }],
          rows: [{ $skip: skip }, { $limit: l }],
        },
      },
    ]);
    const total = facet?.meta?.[0]?.total ?? 0;
    return { items: toApiJSONList(facet?.rows ?? []), total, page: p, limit: l };
  },

  async get(company, designId) {
    const design = await getDesign(company, designId);
    const result = await ledger(company, design);
    // Get the most recent invoice's T&C for pre-filling the form
    const latestInvoice = await Invoice.findOne({ company: company._id, design: design._id }).sort({ createdAt: -1 }).lean();
    result.previousTermsAndConditions = latestInvoice?.termsAndConditions || '';
    result.previousBillToCompany = latestInvoice?.billToCompany || '';
    result.nextInvoiceNo = await peekInvoiceNo(company);
    return result;
  },

  async addPayment(company, user, designId, body) {
    const design = await getDesign(company, designId);
    if (design.status !== 'won') throw badRequest('Receipts can be created only after the proposal is marked as Booked');
    const { total, balance } = await ledger(company, design);
    if (!(total > 0)) throw badRequest('This proposal has no price yet');
    const amount = money(body.amount);
    if (!(amount > 0)) throw badRequest('Enter the amount received');
    if (amount > balance + 0.001) throw badRequest(`The amount is more than the balance due (${balance})`);
    const receivedOn = body.receivedOn ? new Date(body.receivedOn) : new Date();
    if (Number.isNaN(receivedOn.getTime())) throw badRequest('Invalid payment date');
    const payment = await Payment.create({
      company: company._id,
      design: design._id,
      client: design.client._id,
      receiptNo: await nextNumber(company, 'receipt', 'RCT'),
      amount,
      mode: body.mode,
      reference: body.reference || '',
      receivedOn,
      note: body.note || '',
      contractTotal: total,
      balanceAfter: money(balance - amount),
      createdByName: user?.name || user?.email || '',
    });
    return { payment, ...(await ledger(company, design)) };
  },

  /** Standalone receipt (no proposal): payer in `billTo`, optional link to an existing client. */
  async createDirectReceipt(company, user, body = {}) {
    const amount = money(body.amount);
    if (!(amount > 0)) throw badRequest('Enter the amount received');
    const billTo = {
      name: String(body.billTo?.name || '').trim(),
      phone: body.billTo?.phone || '',
      email: body.billTo?.email || '',
      address: body.billTo?.address || '',
    };
    if (!billTo.name) throw badRequest('Enter who the payment is from');
    let clientId = null;
    if (body.client) {
      const client = await Client.findOne({ _id: objectId(body.client, 'Client'), company: company._id }).select('_id').lean();
      if (!client) throw notFound('Client');
      clientId = client._id;
    }
    const receivedOn = body.receivedOn ? new Date(body.receivedOn) : new Date();
    if (Number.isNaN(receivedOn.getTime())) throw badRequest('Invalid payment date');
    const payment = await Payment.create({
      company: company._id,
      design: null,
      client: clientId,
      billTo,
      title: String(body.title || '').trim() || billTo.name,
      receiptNo: await nextNumber(company, 'receipt', 'RCT'),
      amount,
      mode: body.mode,
      reference: body.reference || '',
      receivedOn,
      note: body.note || '',
      contractTotal: amount,
      balanceAfter: 0,
      createdByName: user?.name || user?.email || '',
    });
    return { payment: toApiJSON(payment.toObject()) };
  },

  /** Only the latest receipt can be cancelled. */
  async removePayment(company, id) {
    const payment = await Payment.findOne({ _id: objectId(id, 'Receipt'), company: company._id });
    if (!payment) throw notFound('Receipt');
    const later = await Payment.exists({ design: payment.design, createdAt: { $gt: payment.createdAt } });
    if (later) throw badRequest('Only the latest receipt can be removed');
    if (payment.pdfName) {
      await revokeSharesForPdf(payment.pdfName);
      await deleteFile(payment.pdfName);
    }
    await payment.deleteOne();
    return { ok: true };
  },

  async attachReceiptPdf(company, paymentId, pdfName) {
    if (!pdfName) throw badRequest('Upload a PDF');
    return archivePdfOnce(Payment, 'Receipt', company, paymentId, pdfName);
  },

  async createInvoice(company, user, designId, body = {}) {
    const design = await getDesign(company, designId);
    const l = await ledger(company, design);
    if (design.status !== 'won') throw badRequest('The proposal must be Booked');
    if (!(l.total > 0)) throw badRequest('This proposal has no price yet');
    const input = body.pricing && typeof body.pricing === 'object' ? body.pricing : design.summary?.pricing;
    const pricingFor = (lines) => {
      const pricing = resolveInvoicePricing(body.pricing ? { ...body.pricing, lines } : null, input?.lines?.length ? { ...input, lines } : design.summary?.pricing);
      if (!pricing) throw badRequest('This proposal has no price yet');
      if (!(money(pricing.total) > 0)) throw badRequest('Invoice total must be greater than zero');
      return pricing;
    };
    const created = await issueInvoice(company, input?.lines || [], pricingFor, {
      company: company._id,
      design: design._id,
      client: design.client._id,
      title: design.name,
      billToCompany: String(body.billToCompany || '').trim().slice(0, 120),
      details: cleanInvoiceDetails(body.details),
      termsAndConditions: cleanRichText(body.termsAndConditions || ''),
      createdByName: user?.name || user?.email || '',
    });
    const out = await ledger(company, design);
    return { ...out, createdInvoice: toApiJSON(created.toObject()) };
  },

  /** The number the next invoice (of any kind) will get. */
  async nextInvoiceNumber(company) {
    return { nextInvoiceNo: await peekInvoiceNo(company) };
  },

  /**
   * An invoice without a proposal: the buyer is typed in (`billTo`), optionally linked to an existing client, and the
   * lines come straight from the form. Nothing else is created — no client record, no proposal.
   */
  async createDirectInvoice(company, user, body = {}) {
    // stock lines are priced from their batches inside the transaction; the totals are checked there
    if (!Array.isArray(body.pricing?.lines) || !body.pricing.lines.some((l) => String(l?.name || '').trim())) throw badRequest('Add at least one line item');
    const billTo = {
      name: String(body.billTo?.name || '').trim(),
      company: String(body.billTo?.company || '').trim().slice(0, 120),
      phone: body.billTo?.phone || '',
      email: body.billTo?.email || '',
      address: body.billTo?.address || '',
      gstNumber: body.billTo?.gstNumber || '',
    };
    if (!billTo.name) throw badRequest('Enter who the invoice is for');
    let clientId = null;
    if (body.client) {
      const client = await Client.findOne({ _id: objectId(body.client, 'Client'), company: company._id }).select('_id').lean();
      if (!client) throw notFound('Client');
      clientId = client._id;
    }
    const created = await issueInvoice(company, body.pricing.lines, (lines) => authorityInvoicePricing({ ...body.pricing, lines }), {
      company: company._id,
      design: null,
      client: clientId,
      billTo,
      title: String(body.title || '').trim() || billTo.name,
      details: cleanInvoiceDetails(body.details),
      termsAndConditions: cleanRichText(body.termsAndConditions || ''),
      createdByName: user?.name || user?.email || '',
    });
    return { createdInvoice: toApiJSON(created.toObject()) };
  },

  /**
   * Parts replaced on an AMC visit, billed to the proposal's client: one invoice on the proposal whose lines are taken
   * from stock and priced from their batches at the chosen price type. project.service records it on the visit.
   */
  async createAmcPartsInvoice(company, user, { project, visit, lines, withGst = true }) {
    const design = await Design.findOne({ _id: project.design, company: company._id }).select('name client');
    if (!design) throw notFound('Proposal');
    const input = (lines || []).map((l) => ({ productId: l.productId, qty: l.qty, batch: l.batch, serials: l.serials, priceType: l.priceType || 'retail', name: '', rate: 0 }));
    const pricingFor = (allocated) => authorityInvoicePricing({ lines: allocated, withGst, invoiceGstMode: withGst ? 'with_gst' : 'without_gst', gstIncluded: false });
    return issueInvoice(company, input, pricingFor, {
      company: company._id,
      design: design._id,
      client: design.client,
      title: `${visit.name} — parts used · ${design.name}`.slice(0, 160),
      termsAndConditions: cleanRichText(company.pdfTerms || ''),
      createdByName: user?.name || user?.email || '',
    });
  },

  async attachInvoicePdf(company, invoiceId, pdfName) {
    if (!pdfName) throw badRequest('Upload a PDF');
    return archivePdfOnce(Invoice, 'Invoice', company, invoiceId, pdfName);
  },
};

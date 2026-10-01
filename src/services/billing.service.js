// Receipts and tax invoices for booked proposals (each invoice generation is stored separately).
import { Client, Counter, Design, Invoice, Payment } from '../models/index.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { parsePagination, toApiJSON, toApiJSONList } from '../utils/lean.js';
import { cleanRichText } from '../utils/richText.js';
import { objectId } from '../utils/validators.js';
import { createNumberedInvoice, peekInvoiceNo } from './invoiceNumber.service.js';

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

export const billingService = {
  /** Every won proposal with what has been received so far. */
  async overview(company) {
    const designs = await Design.find({ company: company._id, status: 'won' }).select('-data').populate('client', 'name phone email').sort({ updatedAt: -1 });
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

  async listPayments(company, { page, limit } = {}) {
    const filter = { company: company._id };
    const { page: p, limit: l, skip } = parsePagination({ page, limit });
    const [items, total] = await Promise.all([
      Payment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(l).populate('client', 'name').populate('design', 'name').lean(),
      Payment.countDocuments(filter),
    ]);
    return { items: toApiJSONList(items), total, page: p, limit: l };
  },
  async listInvoices(company, { page, limit } = {}) {
    const filter = { company: company._id };
    const { page: p, limit: l, skip } = parsePagination({ page, limit });
    const [items, total] = await Promise.all([
      Invoice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(l).populate('client', 'name').lean(),
      Invoice.countDocuments(filter),
    ]);
    return { items: toApiJSONList(items), total, page: p, limit: l };
  },

  async get(company, designId) {
    const design = await getDesign(company, designId);
    const result = await ledger(company, design);
    // Get the most recent invoice's T&C for pre-filling the form
    const latestInvoice = await Invoice.findOne({ company: company._id, design: design._id }).sort({ createdAt: -1 }).lean();
    result.previousTermsAndConditions = latestInvoice?.termsAndConditions || '';
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

  /** Only the latest receipt can be cancelled. */
  async removePayment(company, id) {
    const payment = await Payment.findOne({ _id: objectId(id, 'Receipt'), company: company._id });
    if (!payment) throw notFound('Receipt');
    const later = await Payment.exists({ design: payment.design, createdAt: { $gt: payment.createdAt } });
    if (later) throw badRequest('Only the latest receipt can be removed');
    await payment.deleteOne();
    return { ok: true };
  },

  async createInvoice(company, user, designId, body = {}) {
    const design = await getDesign(company, designId);
    const l = await ledger(company, design);
    if (design.status !== 'won') throw badRequest('The proposal must be Booked');
    if (!(l.total > 0)) throw badRequest('This proposal has no price yet');
    let pricing = design.summary?.pricing || null;
    let invTotal = l.total;
    if (body.pricing && typeof body.pricing === 'object') {
      invTotal = money(body.pricing.total);
      if (!(invTotal > 0)) throw badRequest('Invoice total must be greater than zero');
      pricing = body.pricing;
    }
    const created = await createNumberedInvoice(company, {
      company: company._id,
      design: design._id,
      client: design.client._id,
      title: design.name,
      total: invTotal,
      pricing,
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
    const pricing = body.pricing && typeof body.pricing === 'object' ? body.pricing : null;
    const total = money(pricing?.total);
    if (!pricing || !Array.isArray(pricing.lines) || !pricing.lines.some((l) => String(l?.name || '').trim())) throw badRequest('Add at least one line item');
    if (!(total > 0)) throw badRequest('Invoice total must be greater than zero');
    const billTo = {
      name: String(body.billTo?.name || '').trim(),
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
    const created = await createNumberedInvoice(company, {
      company: company._id,
      design: null,
      client: clientId,
      billTo,
      title: String(body.title || '').trim() || billTo.name,
      total,
      pricing,
      termsAndConditions: cleanRichText(body.termsAndConditions || ''),
      createdByName: user?.name || user?.email || '',
    });
    return { createdInvoice: toApiJSON(created.toObject()) };
  },

  async attachInvoicePdf(company, invoiceId, pdfName) {
    if (!pdfName) throw badRequest('Upload a PDF');
    const invoice = await Invoice.findOne({ _id: objectId(invoiceId, 'Invoice'), company: company._id });
    if (!invoice) throw notFound('Invoice');
    invoice.pdfName = pdfName;
    await invoice.save();
    return { ok: true, pdfName };
  },
};

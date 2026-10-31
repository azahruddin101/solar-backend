// The proposal's and the client's money ledgers, the invoice that settles bills (the sale chain: ewayBill.service.js →
// bill.service.js → here) and the invoice for parts used on an AMC visit. Invoices are never made straight from a
// proposal: they come from paid bills.
import mongoose from 'mongoose';
import { Bill, Client, Design, Invoice, Payment, SerialUnit } from '../models/index.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import { parsePagination, toApiJSON, toApiJSONList } from '../utils/lean.js';
import { dateRangeOnField } from '../utils/listFilters.js';
import { cleanRichText } from '../utils/richText.js';
import { cleanIdempotencyKey, createOnce } from '../utils/idempotency.js';
import { objectId } from '../utils/validators.js';
import { createNumberedInvoice, peekInvoiceNo } from './invoiceNumber.service.js';
import { authorityInvoicePricing, consolidatePricing } from './invoicePricing.service.js';
import { billService } from './bill.service.js';
import { creditNoteService } from './creditNote.service.js';
import { ewayBillService, partyFilter, resolveParty } from './ewayBill.service.js';
import { archivePdfOnce } from './archivePdf.service.js';
import { allocateInvoiceLines, inTransaction } from './stock.service.js';

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

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
  const party = { design };
  const [ewayBills, bills, creditNotes] = await Promise.all([ewayBillService.forParty(company, party), billService.forParty(company, party), creditNoteService.forParty(company, party)]);
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
    invoices: invoiceRows,
    invoice: invoiceRows.find((i) => i.status !== 'void' && i.kind !== 'amc_parts') || null, // the latest sale invoice that still stands
    ...chainSummary(ewayBills, bills),
    creditNotes,
  };
}

/** The e-way bills and bills of a party, with the counts the billing page's buttons need. */
function chainSummary(ewayBills, bills) {
  return {
    ewayBills,
    bills,
    openEwayBills: ewayBills.filter((e) => e.status === 'open').length,
    uninvoicedBills: bills.filter((b) => b.status === 'paid').length,
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
async function issueInvoice(company, inputLines, pricingFor, fields, { session: outer = null } = {}) {
  const run = async (session) => {
    const invoiceId = new mongoose.Types.ObjectId(); // the sold units point at it
    const lines = await allocateInvoiceLines(company, inputLines, { invoiceId, session });
    const pricing = pricingFor(lines);
    return createNumberedInvoice(company, { _id: invoiceId, ...fields, total: money(pricing.total), pricing }, { session });
  };
  return outer ? run(outer) : inTransaction(run); // an outer transaction lets the caller record the invoice in the same commit
}

export const billingService = {
  /** Every won proposal with what has been received so far. */
  async overview(company, { from, to } = {}) {
    const match = { company: company._id, status: 'won', ...(dateRangeOnField('createdAt', from, to) || {}) };
    const designs = await Design.find(match).select('-data').populate('client', 'name phone email').sort({ updatedAt: -1 });
    const sums = await Payment.aggregate([{ $match: { company: company._id, design: { $in: designs.map((d) => d._id) } } }, { $group: { _id: '$design', paid: { $sum: '$amount' }, count: { $sum: 1 }, lastPaidOn: { $max: '$receivedOn' } } }]);
    const invoices = await Invoice.find({ company: company._id, status: { $ne: 'void' }, kind: { $ne: 'amc_parts' }, design: { $in: designs.map((d) => d._id) } }).select('design invoiceNo createdAt').sort({ createdAt: -1 });
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
      return { id: d.id, name: d.name, type: d.type, client: d.client, total, paid, balance: money(total - paid), payments: s?.count || 0, invoiceNo: inv?.invoiceNo || '', lastPaidOn: s?.lastPaidOn || null, bookedOn: d.updatedAt };
    });
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
    const latestInvoice = await Invoice.findOne({ company: company._id, design: design._id, kind: { $ne: 'amc_parts' } }).sort({ createdAt: -1 }).lean();
    result.previousTermsAndConditions = latestInvoice?.termsAndConditions || '';
    result.previousBillToCompany = latestInvoice?.billToCompany || '';
    result.nextInvoiceNo = await peekInvoiceNo(company);
    return result;
  },

  /** The number the next invoice (of any kind) will get. */
  async nextInvoiceNumber(company) {
    return { nextInvoiceNo: await peekInvoiceNo(company) };
  },

  /**
   * Parts replaced on an AMC visit, billed to the proposal's client: one invoice on the proposal whose lines are taken
   * from stock and priced from their batches at the chosen price type. project.service records it on the visit, inside
   * the `session` it passes, so the invoice, the stock and the visit are one commit.
   */
  async createAmcPartsInvoice(company, user, { project, visit, lines, withGst = true, session = null }) {
    const design = await Design.findOne({ _id: project.design, company: company._id }).select('name client');
    if (!design) throw notFound('Proposal');
    const input = (lines || []).map((l) => ({ productId: l.productId, qty: l.qty, batch: l.batch, serials: l.serials, priceType: l.priceType || 'retail', name: '', rate: 0 }));
    const pricingFor = (allocated) => authorityInvoicePricing({ lines: allocated, withGst, invoiceGstMode: withGst ? 'with_gst' : 'without_gst', gstIncluded: false });
    return issueInvoice(company, input, pricingFor, {
      company: company._id,
      design: design._id,
      client: design.client,
      title: `${visit.name} — parts used · ${design.name}`.slice(0, 160),
      kind: 'amc_parts',
      termsAndConditions: cleanRichText(company.pdfTerms || ''),
      createdByName: user?.name || user?.email || '',
    }, { session });
  },

  /**
   * A client's money with no proposal: e-way bills, bills and invoices made on the client alone (the
   * proposal-less sale chain). Same shape as `get` so the billing page can show either.
   */
  async getClient(company, clientId) {
    const client = await Client.findOne({ _id: objectId(clientId, 'Client'), company: company._id }).select('name phone email address gstNumber').lean();
    if (!client) throw notFound('Client');
    const party = { client, design: null };
    const [payments, invoices, ewayBills, bills, creditNotes] = await Promise.all([
      Payment.find({ company: company._id, ...partyFilter(party) }).sort({ createdAt: 1 }).lean(),
      Invoice.find({ company: company._id, ...partyFilter(party) }).sort({ createdAt: -1 }).lean(),
      ewayBillService.forParty(company, party),
      billService.forParty(company, party),
      creditNoteService.forParty(company, party),
    ]);
    const invoiceRows = toApiJSONList(invoices);
    const paid = money(payments.reduce((a, p) => a + p.amount, 0));
    const billed = money(bills.reduce((a, b) => a + b.total, 0));
    return {
      client: toApiJSON(client),
      total: billed,
      paid,
      balance: money(billed - paid),
      invoices: invoiceRows,
      invoice: invoiceRows.find((i) => i.status !== 'void' && i.kind !== 'amc_parts') || null,
      previousTermsAndConditions: invoices[0]?.termsAndConditions || '',
      previousBillToCompany: invoices[0]?.billToCompany || invoices[0]?.billTo?.company || '',
      nextInvoiceNo: await peekInvoiceNo(company),
      ...chainSummary(ewayBills, bills),
      creditNotes,
    };
  },

  /**
   * The invoice that settles bills: every paid, not yet invoiced bill of a proposal (or client) goes on it, and the
   * invoice takes their frozen lines and totals as they are (invoicePricing.service.js consolidatePricing). In one
   * transaction the bills are marked invoiced and the sold units get the invoice they were sold on. `body.bills`
   * (ids) may narrow it to some of those bills.
   */
  async createInvoiceFromBills(company, user, body = {}) {
    const wantIds = [...new Set((Array.isArray(body.bills) ? body.bills : []).map((id) => String(id)))];
    const idempotencyKey = cleanIdempotencyKey(body.idempotencyKey);
    return createOnce(Invoice, company, idempotencyKey, async () => {
      const created = await inTransaction(async (session) => {
        const party = await resolveParty(company, body, session);
        const bills = await Bill.find({ company: company._id, ...partyFilter(party), ...(wantIds.length ? { _id: { $in: wantIds.map((id) => objectId(id, 'Bill')) } } : { status: 'paid' }) }).sort({ createdAt: 1 }).populate('ewayBills', 'ewayNo').session(session).lean();
        if (wantIds.length && bills.length !== wantIds.length) throw notFound('Bill');
        if (!bills.length) throw badRequest('There is no paid bill to invoice yet');
        const done = bills.filter((b) => b.status !== 'paid');
        if (done.length) throw conflict(`${done.map((b) => b.billNo).join(', ')} ${done.length === 1 ? 'is' : 'are'} already invoiced`);
        const pricing = consolidatePricing(bills);
        if (!(money(pricing.total) > 0)) throw badRequest('Invoice total must be greater than zero');
        const invoiceId = new mongoose.Types.ObjectId();
        const marked = await Bill.updateMany({ _id: { $in: bills.map((b) => b._id) }, status: 'paid' }, { $set: { status: 'invoiced', invoice: invoiceId } }, { session });
        if (marked.modifiedCount !== bills.length) throw conflict('One of these bills was just invoiced. Refresh and try again');
        const ewayBillIds = bills.flatMap((b) => (b.ewayBills || []).map((e) => e._id));
        if (ewayBillIds.length) await SerialUnit.updateMany({ company: company._id, soldEwayBill: { $in: ewayBillIds } }, { $set: { soldInvoice: invoiceId } }, { session });
        const client = party.design ? null : await Client.findById(party.client._id).select('name phone email address gstNumber').session(session).lean();
        return createNumberedInvoice(company, {
          _id: invoiceId,
          company: company._id,
          design: party.design?._id ?? null,
          client: party.client._id,
          // a client-only invoice prints the client's details from a copy, like a direct invoice does
          billTo: client ? { name: client.name, company: String(body.billToCompany || '').trim().slice(0, 120), phone: client.phone || '', email: client.email || '', address: client.address || '', gstNumber: client.gstNumber || '' } : null,
          billToCompany: party.design ? String(body.billToCompany || '').trim().slice(0, 120) : '',
          title: party.title,
          total: money(pricing.total),
          pricing,
          bills: bills.map((b) => b._id),
          billRefs: bills.map((b) => ({ bill: b._id, billNo: b.billNo, issuedOn: b.issuedOn, total: b.total, ewayNos: (b.ewayBills || []).map((e) => e.ewayNo) })),
          details: cleanInvoiceDetails(body.details),
          termsAndConditions: cleanRichText(body.termsAndConditions || ''),
          createdByName: user?.name || user?.email || '',
          idempotencyKey: idempotencyKey || undefined,
        }, { session });
      });
      return { createdInvoice: toApiJSON(created.toObject()) };
    }, (row) => ({ createdInvoice: toApiJSON(row) }));
  },

  /**
   * Void an invoice made from bills. It stays as the record (number never reused, with who voided it and why); its
   * bills become paid again, so they can be voided or put on a new invoice. Parts invoices from an AMC visit have no bills
   * and are not voided here.
   */
  async voidInvoice(company, user, id, body = {}) {
    const reason = String(body.reason || '').trim().slice(0, 300);
    if (!reason) throw badRequest('Give the reason for voiding this invoice');
    return inTransaction(async (session) => {
      const invoice = await Invoice.findOne({ _id: objectId(id, 'Invoice'), company: company._id }).session(session);
      if (!invoice) throw notFound('Invoice');
      if (invoice.status === 'void') throw badRequest('This invoice is already void');
      if (!invoice.bills?.length) throw badRequest('Only an invoice made from bills can be voided here');
      await Bill.updateMany({ _id: { $in: invoice.bills }, company: company._id, invoice: invoice._id, status: 'invoiced' }, { $set: { status: 'paid', invoice: null } }, { session });
      await SerialUnit.updateMany({ company: company._id, soldInvoice: invoice._id }, { $set: { soldInvoice: null } }, { session });
      const voided = await Invoice.findOneAndUpdate(
        { _id: invoice._id, status: { $ne: 'void' } },
        { $set: { status: 'void', voidedAt: new Date(), voidReason: reason, voidedByName: user?.name || user?.email || '' } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!voided) throw conflict('This invoice was just changed. Refresh and try again');
      return toApiJSON(voided);
    });
  },

  async attachInvoicePdf(company, invoiceId, pdfName) {
    if (!pdfName) throw badRequest('Upload a PDF');
    return archivePdfOnce(Invoice, 'Invoice', company, invoiceId, pdfName);
  },
};

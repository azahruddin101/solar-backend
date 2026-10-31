// E-way bills: goods leaving stock for a client, the first document of the sale chain (e-way bill → bill → invoice).
// Creating one takes the stock of its lines in the same transaction (stock.service.js); cancelling an e-way bill that
// is not on a bill yet puts the stock back.
import mongoose from 'mongoose';
import { TRANSPORT_MODES, TRANSPORT_REASONS } from '../constants/index.js';
import { Client, Counter, Design, EwayBill } from '../models/index.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import { parsePagination, toApiJSON, toApiJSONList } from '../utils/lean.js';
import { dateRangeOnField } from '../utils/listFilters.js';
import { cleanIdempotencyKey, createOnce } from '../utils/idempotency.js';
import { objectId } from '../utils/validators.js';
import { archivePdfOnce } from './archivePdf.service.js';
import { authorityInvoicePricing } from './invoicePricing.service.js';
import { allocateInvoiceLines, inTransaction, returnStock } from './stock.service.js';

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** The company's own running number for a document kind: EWB-0001, BILL-0001… */
export async function nextDocumentNumber(company, key, prefix, session = null) {
  const c = await Counter.findOneAndUpdate({ company: company._id, key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session });
  return `${prefix}-${String(c.seq).padStart(4, '0')}`;
}

/**
 * Who a chain document is for: a booked proposal (`design`, whose client it takes) or a client on their own.
 * Returns { design (doc or null), client (doc), title }.
 */
export async function resolveParty(company, { design, client } = {}, session = null) {
  if (design) {
    const d = await Design.findOne({ _id: objectId(design, 'Proposal'), company: company._id }).select('name status client').populate('client', 'name').session(session);
    if (!d) throw notFound('Proposal');
    if (d.status !== 'won') throw badRequest('The proposal must be Booked first');
    if (!d.client) throw badRequest('This proposal has no client');
    return { design: d, client: d.client, title: d.name };
  }
  if (!client) throw badRequest('Choose the client or the booked proposal');
  const c = await Client.findOne({ _id: objectId(client, 'Client'), company: company._id }).select('name').session(session);
  if (!c) throw notFound('Client');
  return { design: null, client: c, title: c.name };
}

/** The filter for one party's documents: a proposal's, or a client's with no proposal. */
export const partyFilter = ({ design, client }) => (design ? { design: design._id ?? design } : { client: client._id ?? client, design: null });

const TEXT = { vehicleNo: 20, transporter: 120, transporterId: 15, docNo: 80, docDate: 20, fromPlace: 200, toPlace: 200 };

/** Transport details from the form: known fields only, trimmed; the mode and reason fall back to road / supply. */
export function cleanTransport(input) {
  const t = input && typeof input === 'object' ? input : {};
  const out = { mode: TRANSPORT_MODES.includes(t.mode) ? t.mode : 'road', reason: TRANSPORT_REASONS.includes(t.reason) ? t.reason : 'supply' };
  for (const [k, max] of Object.entries(TEXT)) out[k] = String(t[k] ?? '').trim().slice(0, max);
  out.vehicleNo = out.vehicleNo.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  out.transporterId = out.transporterId.toUpperCase();
  const km = t.distanceKm === '' || t.distanceKm == null ? null : Number(t.distanceKm);
  if (km != null && (!Number.isFinite(km) || km < 0)) throw badRequest('Distance must be 0 or more');
  out.distanceKm = km;
  return out;
}

const summary = (row) => ({
  ...toApiJSON(row),
  itemCount: (row.lines || []).reduce((a, l) => a + (Number(l.qty) || 0), 0),
  lineCount: (row.lines || []).length,
});

export const ewayBillService = {
  /** Every e-way bill of the company, newest first, paged; `status` and the issue-date range are optional. */
  async list(company, { page, limit, from, to, status } = {}) {
    const match = { company: company._id, ...(status ? { status } : {}), ...(dateRangeOnField('issuedOn', from, to) || {}) };
    const { page: p, limit: l, skip } = parsePagination({ page, limit });
    const [rows, total] = await Promise.all([
      EwayBill.find(match).sort({ createdAt: -1 }).skip(skip).limit(l).populate('client', 'name').populate('design', 'name').populate('bill', 'billNo').lean(),
      EwayBill.countDocuments(match),
    ]);
    return { items: rows.map(summary), total, page: p, limit: l };
  },

  /** One party's e-way bills (all statuses), newest first — the proposal's or the client's billing page. */
  async forParty(company, party) {
    const rows = await EwayBill.find({ company: company._id, ...partyFilter(party) }).sort({ createdAt: -1 }).populate('bill', 'billNo').lean();
    return rows.map(summary);
  },

  /** The open e-way bills a bill can be made for. */
  async open(company, { design, client }) {
    const party = await resolveParty(company, { design, client });
    const rows = await EwayBill.find({ company: company._id, ...partyFilter(party), status: 'open' }).sort({ createdAt: 1 }).lean();
    return rows.map(summary);
  },

  async get(company, id) {
    const row = await EwayBill.findOne({ _id: objectId(id, 'E-way bill'), company: company._id }).populate('client', 'name phone email address gstNumber').populate('design', 'name').populate('bill', 'billNo').lean();
    if (!row) throw notFound('E-way bill');
    return summary(row);
  },

  /**
   * Generate an e-way bill: every line is a product from stock (`productId`, `priceType`, and a quantity, a batch or
   * serial numbers). The stock is taken and the lines priced from their batches in one transaction with the insert.
   * With an `idempotencyKey`, repeating the request returns the e-way bill it made instead of taking the stock again.
   */
  async create(company, user, body = {}) {
    const input = Array.isArray(body.lines) ? body.lines.filter((l) => l && l.productId) : [];
    if (!input.length) throw badRequest('Add at least one product from stock');
    if (input.length !== (body.lines || []).length) throw badRequest('Every line of an e-way bill must be a product from stock');
    const withGst = body.withGst !== false;
    const transport = cleanTransport(body.transport);
    const govtEwayNo = String(body.govtEwayNo ?? '').replace(/\D/g, '');
    if (govtEwayNo && govtEwayNo.length !== 12) throw badRequest('The e-way bill number from the GST portal has 12 digits');
    const issuedOn = body.issuedOn ? new Date(body.issuedOn) : new Date();
    if (Number.isNaN(issuedOn.getTime())) throw badRequest('Invalid date');
    const idempotencyKey = cleanIdempotencyKey(body.idempotencyKey);
    return createOnce(EwayBill, company, idempotencyKey, () => inTransaction(async (session) => {
      const party = await resolveParty(company, body, session);
      const ewayBillId = new mongoose.Types.ObjectId();
      const lines = await allocateInvoiceLines(company, input.map((l) => ({ ...l, kind: 'goods', name: '', rate: 0 })), { ewayBillId, session });
      const pricing = authorityInvoicePricing({ lines, gstIncluded: false, withGst, invoiceGstMode: withGst ? 'with_gst' : 'without_gst' });
      const [created] = await EwayBill.create([{
        _id: ewayBillId,
        company: company._id,
        design: party.design?._id ?? null,
        client: party.client._id,
        ewayNo: await nextDocumentNumber(company, 'ewaybill', 'EWB', session),
        govtEwayNo,
        issuedOn,
        title: party.title,
        lines: pricing.lines,
        pricing,
        total: money(pricing.total),
        transport,
        note: String(body.note || '').trim().slice(0, 300),
        createdByName: user?.name || user?.email || '',
        idempotencyKey: idempotencyKey || undefined,
      }], { session });
      return summary(created.toObject());
    }), summary);
  },

  /** Cancel an e-way bill that is not on a bill yet: its goods go back into stock. */
  async cancel(company, id, body = {}) {
    return inTransaction(async (session) => {
      const row = await EwayBill.findOne({ _id: objectId(id, 'E-way bill'), company: company._id }).session(session);
      if (!row) throw notFound('E-way bill');
      if (row.status === 'cancelled') throw badRequest('This e-way bill is already cancelled');
      if (row.status === 'billed' || row.bill) throw conflict(`E-way bill ${row.ewayNo} is on a bill and can't be cancelled`);
      await returnStock(company, row.lines, { ewayBillId: row._id, session });
      const updated = await EwayBill.findOneAndUpdate(
        { _id: row._id, status: 'open' },
        { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: String(body.reason || '').trim().slice(0, 300) } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!updated) throw conflict('This e-way bill was just changed. Refresh and try again');
      return summary(updated);
    });
  },

  async attachPdf(company, id, pdfName) {
    if (!pdfName) throw badRequest('Upload a PDF');
    return archivePdfOnce(EwayBill, 'E-way bill', company, id, pdfName);
  },
};

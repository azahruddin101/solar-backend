// E-way bills: goods leaving stock for a client, the first document of the sale chain (e-way bill → bill → invoice).
// Creating one takes the stock of its lines in the same transaction (stock.service.js); cancelling an e-way bill that
// is not on a bill yet puts the stock back.
import mongoose from 'mongoose';
import { PAYMENT_MODES, TRANSPORT_MODES, TRANSPORT_REASONS } from '../constants/index.js';
import { Bill, Client, Counter, Design, EwayBill, Payment } from '../models/index.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import { parsePagination, toApiJSON, toApiJSONList } from '../utils/lean.js';
import { dateRangeOnField } from '../utils/listFilters.js';
import { cleanIdempotencyKey, createOnce } from '../utils/idempotency.js';
import { objectId } from '../utils/validators.js';
import { archivePdfOnce } from './archivePdf.service.js';
import { cleanServices, serviceLine } from './bill.service.js';
import { authorityInvoicePricing } from './invoicePricing.service.js';
import { allocateInvoiceLines, inTransaction, reassignSoldSerials, returnStock, returnStockPartial } from './stock.service.js';

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const EPS = 0.0005;

const goodsLineIndexes = (row) => (row.lines || []).map((line, index) => ({ line, index })).filter(({ line }) => line?.productId);

/** What can still be returned on an open product bill (by line index on `lines`). */
export async function returnableEwayOf(company, id) {
  const row = await EwayBill.findOne({ _id: objectId(id, 'E-way bill'), company: company._id }).lean();
  if (!row) throw notFound('Bill');
  if (row.status !== 'open') throw badRequest('Only an open product bill can be revised');
  return {
    bill: { id: String(row._id), ewayNo: row.ewayNo, status: row.status, total: row.total },
    lines: goodsLineIndexes(row).map(({ line, index }) => ({
      line: index,
      name: line.name,
      detail: line.detail || '',
      batchNo: line.batchNo || '',
      unit: line.unit || '',
      qty: line.qty,
      serials: (line.serials || []).map(String),
      qtyLeft: Number(line.qty) || 0,
    })),
  };
}

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

/**
 * What a party owes before a new bill: its standing bills (open bills and older invoices) less everything it has paid.
 * Negative when it holds an advance (receipts beyond what was billed).
 */
async function dueBefore(company, party, session) {
  const match = { company: company._id, ...partyFilter(party) };
  const sum = async (Model, extra, field) => (await Model.aggregate([{ $match: { ...match, ...extra } }, { $group: { _id: null, sum: { $sum: `$${field}` } } }]).session(session))[0]?.sum || 0;
  const [open, invoiced, received] = [await sum(EwayBill, { status: 'open' }, 'total'), await sum(Bill, { status: { $ne: 'void' } }, 'total'), await sum(Payment, {}, 'amount')];
  return { billed: money(open + invoiced), due: money(open + invoiced - received) };
}

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
  supersededByNo: row.supersededBy?.ewayNo || row.supersededByNo || null,
  supersedesNo: row.supersedes?.ewayNo || row.supersedesNo || null,
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
    const rows = await EwayBill.find({ company: company._id, ...partyFilter(party) }).sort({ createdAt: -1 }).populate('bill', 'billNo').populate('supersededBy', 'ewayNo').populate('supersedes', 'ewayNo').lean();
    return rows.map((row) => summary({
      ...row,
      supersededByNo: row.supersededBy?.ewayNo ?? null,
      supersedesNo: row.supersedes?.ewayNo ?? null,
    }));
  },

  /** The open e-way bills a bill can be made for. */
  async open(company, { design, client }) {
    const party = await resolveParty(company, { design, client });
    const rows = await EwayBill.find({ company: company._id, ...partyFilter(party), status: 'open' }).sort({ createdAt: 1 }).lean();
    return rows.map(summary);
  },

  async get(company, id) {
    const row = await EwayBill.findOne({ _id: objectId(id, 'E-way bill'), company: company._id }).populate('client', 'name phone email address gstNumber').populate('design', 'name').populate('bill', 'billNo').lean();
    if (!row) throw notFound('Bill');
    return summary(row);
  },

  /**
   * Generate a bill: product lines from stock and/or service charges, with optional discount. Product lines take stock
   * in the same transaction as the insert. With an `idempotencyKey`, repeating the request returns the bill it made.
   */
  async create(company, user, body = {}) {
    const input = Array.isArray(body.lines) ? body.lines.filter((l) => l && l.productId) : [];
    const withGst = true;
    const transport = cleanTransport(body.transport);
    const govtEwayNo = String(body.govtEwayNo ?? '').replace(/\D/g, '');
    if (govtEwayNo && govtEwayNo.length !== 12) throw badRequest('The e-way bill number from the GST portal has 12 digits');
    const issuedOn = body.issuedOn ? new Date(body.issuedOn) : new Date();
    if (Number.isNaN(issuedOn.getTime())) throw badRequest('Invalid date');
    const discount = Math.max(0, Number(body.discount) || 0);
    const discountIsPercent = Boolean(body.discountIsPercent);
    if (discountIsPercent && discount > 100) throw badRequest('A percentage discount can be at most 100%');
    const idempotencyKey = cleanIdempotencyKey(body.idempotencyKey);
    // a bill is paid when it is generated: how the money came in (cash unless told otherwise)
    const payment = body.payment && typeof body.payment === 'object' ? body.payment : {};
    const mode = payment.mode || 'cash';
    if (!PAYMENT_MODES.includes(mode)) throw badRequest('Choose how the bill was paid');
    const reference = String(payment.reference || '').trim().slice(0, 80);
    const staff = user?.name || user?.email || '';
    return createOnce(EwayBill, company, idempotencyKey, () => inTransaction(async (session) => {
      const party = await resolveParty(company, body, session);
      const before = await dueBefore(company, party, session);
      const services = await cleanServices(company, body.services, session);
      if (!input.length && !services.length) throw badRequest('Add at least one product from stock or at least one service');
      const ewayBillId = new mongoose.Types.ObjectId();
      const stockLines = input.length
        ? await allocateInvoiceLines(company, input.map((l) => ({ ...l, kind: 'goods', name: '', rate: 0 })), { ewayBillId, session })
        : [];
      const lines = [...stockLines, ...services.map(serviceLine)];
      const pricing = authorityInvoicePricing({
        lines,
        gstIncluded: false,
        withGst,
        invoiceGstMode: withGst ? 'with_gst' : 'without_gst',
        discount,
        discountIsPercent,
        discountRemark: String(body.discountRemark || '').trim().slice(0, 200),
      });
      const total = money(pricing.total);
      const ewayNo = await nextDocumentNumber(company, 'ewaybill', 'BILL', session);
      // the payment: the bill total, less any advance the party already paid on receipts
      const amount = money(Math.min(total, Math.max(0, before.due + total)));
      if (amount >= 0.01) {
        await Payment.create([{
          company: company._id,
          design: party.design?._id ?? null,
          client: party.client._id,
          ewayBill: ewayBillId,
          billTo: { name: party.client.name },
          title: party.title,
          receiptNo: `PMT-${ewayNo}`,
          amount,
          mode,
          reference,
          receivedOn: issuedOn,
          note: `Bill ${ewayNo}`,
          contractTotal: money(before.billed + total),
          balanceAfter: money(before.due + total - amount),
          receivedByName: staff,
          createdByName: staff,
        }], { session });
      }
      const [created] = await EwayBill.create([{
        _id: ewayBillId,
        company: company._id,
        design: party.design?._id ?? null,
        client: party.client._id,
        ewayNo,
        paid: { settled: true, amount, mode, reference },
        govtEwayNo,
        issuedOn,
        title: party.title,
        lines: pricing.lines,
        services,
        pricing,
        total,
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
      if (!row) throw notFound('Bill');
      if (row.status === 'cancelled') throw badRequest('This bill is already cancelled');
      if (row.status === 'superseded') throw badRequest('This bill was revised — use the replacement bill');
      if (row.status === 'billed' || row.bill) throw conflict(`Bill ${row.ewayNo} is on an invoice and can't be cancelled`);
      await returnStock(company, row.lines, { ewayBillId: row._id, session });
      await Payment.deleteMany({ company: company._id, ewayBill: row._id }, { session }); // the bill no longer stands, so neither does its payment
      const updated = await EwayBill.findOneAndUpdate(
        { _id: row._id, status: 'open' },
        { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: String(body.reason || '').trim().slice(0, 300) } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!updated) throw conflict('This bill was just changed. Refresh and try again');
      return summary(updated);
    });
  },

  /**
   * Partially return products on an open bill: stock goes back, this bill is superseded (read-only), and a new open bill
   * is created with the remaining products (and the same services). If everything is returned, the bill is superseded
   * with no replacement.
   */
  async revise(company, user, id, body = {}) {
    const reason = String(body.reason || '').trim().slice(0, 300);
    if (!reason) throw badRequest('Say why the products came back');
    const wanted = Array.isArray(body.lines) ? body.lines : [];
    if (!wanted.length) throw badRequest('Choose at least one product to return');
    if (new Set(wanted.map((w) => w.line)).size !== wanted.length) throw badRequest('Each line can be listed once');

    return inTransaction(async (session) => {
      const row = await EwayBill.findOne({ _id: objectId(id, 'E-way bill'), company: company._id }).session(session);
      if (!row) throw notFound('Bill');
      if (row.status !== 'open') throw badRequest('Only an open product bill can be revised');

      const byIndex = new Map(goodsLineIndexes(row).map(({ line, index }) => [index, { line, index }]));
      const remaining = new Map();
      for (const { line, index } of byIndex.values()) {
        remaining.set(index, { ...line, qty: Number(line.qty) || 0, serials: [...(line.serials || [])].map(String) });
      }

      for (const w of wanted) {
        const g = byIndex.get(w.line);
        if (!g) throw badRequest('Choose a product line from this bill');
        const rem = remaining.get(w.line);
        if (!rem) throw badRequest(`${g.line.name} was already fully returned on this revision`);
        const serialized = rem.serials.length > 0;
        if (serialized) {
          const serials = [...new Set((w.serials || []).map(String))];
          if (!serials.length) throw badRequest(`Choose serial numbers for ${rem.name}`);
          const bad = serials.filter((s) => !rem.serials.includes(s));
          if (bad.length) throw badRequest(`${bad.slice(0, 5).join(', ')} ${bad.length === 1 ? 'is' : 'are'} not on this line`);
          await returnStockPartial(company, rem, { serials }, row._id, session);
          rem.serials = rem.serials.filter((s) => !serials.includes(s));
          rem.qty = rem.serials.length;
        } else {
          const qty = round2(w.qty);
          if (!(qty > 0)) throw badRequest(`Enter how many ${rem.name} came back`);
          if (qty - rem.qty > EPS) throw badRequest(`Only ${rem.qty} ${rem.unit || ''} on this line`.trim());
          await returnStockPartial(company, rem, { qty }, row._id, session);
          rem.qty = round2(rem.qty - qty);
        }
        if (rem.qty <= EPS) remaining.delete(w.line);
        else remaining.set(w.line, rem);
      }

      const keptLines = [...remaining.values()].filter((l) => (Number(l.qty) || 0) > EPS);
      const hasServices = (row.services || []).length > 0 || (row.pricing?.lines || []).some((l) => l.kind === 'service');
      const now = new Date();

      if (!keptLines.length && !hasServices) {
        const updated = await EwayBill.findOneAndUpdate(
          { _id: row._id, status: 'open' },
          { $set: { status: 'superseded', supersededAt: now, cancelReason: `All products returned: ${reason}`.slice(0, 300) } },
          { session, returnDocument: 'after' },
        ).lean();
        if (!updated) throw conflict('This bill was just changed. Refresh and try again');
        await Payment.deleteMany({ company: company._id, ewayBill: row._id }, { session });
        return { superseded: summary(updated), replacement: null };
      }

      const newId = new mongoose.Types.ObjectId();
      const newLines = keptLines.map((l) => ({ ...l, kind: l.kind || 'goods' }));
      const serviceLines = (row.pricing?.lines || []).filter((l) => l.kind === 'service');
      const lines = [...newLines, ...serviceLines];
      const pricing = authorityInvoicePricing({
        lines,
        gstIncluded: false,
        withGst: row.pricing?.withGst !== false,
        invoiceGstMode: row.pricing?.invoiceGstMode || 'with_gst',
        discount: row.pricing?.discount || 0,
        discountIsPercent: row.pricing?.discountIsPercent,
        discountRemark: row.pricing?.discountRemark || '',
      });

      await reassignSoldSerials(company, keptLines, row._id, newId, session);
      const newNo = await nextDocumentNumber(company, 'ewaybill', 'BILL', session);
      // the payment follows the goods: it moves to the replacement bill, lowered to that bill's total
      const paidRow = await Payment.findOne({ company: company._id, ewayBill: row._id }).session(session);
      const keptAmount = paidRow ? money(Math.min(paidRow.amount, pricing.total)) : 0;
      if (paidRow && keptAmount >= 0.01) await Payment.updateOne({ _id: paidRow._id }, { $set: { ewayBill: newId, receiptNo: `PMT-${newNo}`, amount: keptAmount, note: `Bill ${newNo}` } }, { session });
      else if (paidRow) await Payment.deleteOne({ _id: paidRow._id }, { session });

      const [replacement] = await EwayBill.create([{
        _id: newId,
        company: company._id,
        design: row.design,
        client: row.client,
        ewayNo: newNo,
        paid: row.paid?.settled ? { settled: true, amount: keptAmount, mode: row.paid.mode, reference: row.paid.reference || '' } : null,
        govtEwayNo: row.govtEwayNo || '',
        issuedOn: body.issuedOn ? new Date(body.issuedOn) : now,
        title: row.title,
        lines: pricing.lines,
        services: row.services || [],
        pricing,
        total: money(pricing.total),
        transport: row.transport || {},
        note: row.note || '',
        supersedes: row._id,
        createdByName: user?.name || user?.email || '',
      }], { session });

      const superseded = await EwayBill.findOneAndUpdate(
        { _id: row._id, status: 'open' },
        { $set: { status: 'superseded', supersededBy: newId, supersededAt: now, cancelReason: `Revised: ${reason}`.slice(0, 300) } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!superseded) throw conflict('This bill was just changed. Refresh and try again');

      return {
        superseded: { ...summary(superseded), supersededByNo: replacement.ewayNo },
        replacement: summary(replacement.toObject()),
      };
    });
  },

  async attachPdf(company, id, pdfName) {
    if (!pdfName) throw badRequest('Upload a PDF');
    return archivePdfOnce(EwayBill, 'E-way bill', company, id, pdfName);
  },
};

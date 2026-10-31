// Credit notes: some of the goods on a paid bill came back. The returned lines are priced from the bill's frozen lines
// pro rata (so GST and the bill's discount share come with them), the goods go back into stock, and the refund comes
// off the payment of the bill, so every ledger and dashboard drops it at once. The bill and its invoice stay as issued.
import mongoose from 'mongoose';
import { PAYMENT_MODES } from '../constants/index.js';
import { Bill, CreditNote, Payment, SerialUnit } from '../models/index.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import { cleanIdempotencyKey, createOnce } from '../utils/idempotency.js';
import { parsePagination, toApiJSON } from '../utils/lean.js';
import { dateRangeOnField } from '../utils/listFilters.js';
import { objectId } from '../utils/validators.js';
import { archivePdfOnce } from './archivePdf.service.js';
import { nextDocumentNumber, partyFilter } from './ewayBill.service.js';
import { inTransaction, returnStock } from './stock.service.js';

const n = (v) => Number(v) || 0;
const round2 = (v) => Math.round(n(v) * 100) / 100;
const EPS = 0.0005;
const AMOUNTS = ['gross', 'amount', 'taxable', 'gstAmount', 'lineTotal'];

const summary = (row) => toApiJSON(row);

/** The goods lines of a bill, with how much of each earlier credit notes have already taken back. */
function goodsOf(bill, notes) {
  const taken = new Map(); // bill line → { qty, serials, amounts }
  for (const note of notes) {
    for (const l of note.lines || []) {
      const t = taken.get(l.billLine) || { qty: 0, serials: new Set(), sums: Object.fromEntries(AMOUNTS.map((k) => [k, 0])) };
      t.qty += n(l.qty);
      (l.serials || []).forEach((s) => t.serials.add(String(s)));
      for (const k of AMOUNTS) t.sums[k] += n(l[k]);
      taken.set(l.billLine, t);
    }
  }
  return (bill.pricing?.lines || [])
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.productId && line.kind !== 'service')
    .map(({ line, index }) => {
      const t = taken.get(index);
      const serialsLeft = (line.serials || []).map(String).filter((s) => !t?.serials.has(s));
      return { index, line, taken: t || null, qtyLeft: round2(n(line.qty) - n(t?.qty)), serialsLeft };
    });
}

/** What the credit note form shows: each returnable line of the bill and how much of it is left to return. */
export async function returnableOf(company, id) {
  const bill = await Bill.findOne({ _id: objectId(id, 'Bill'), company: company._id }).lean();
  if (!bill) throw notFound('Bill');
  const notes = await CreditNote.find({ company: company._id, bill: bill._id }).select('lines').lean();
  return {
    bill: { id: String(bill._id), billNo: bill.billNo, status: bill.status, total: bill.total, creditedTotal: bill.creditedTotal || 0 },
    lines: goodsOf(bill, notes).map(({ line, index, qtyLeft, serialsLeft }) => ({
      line: index,
      name: line.name,
      detail: line.detail || '',
      ewayNo: line.ewayNo || '',
      batchNo: line.batchNo || '',
      unit: line.unit || '',
      qty: line.qty,
      rate: line.rate,
      gstPercent: line.gstPercent,
      lineTotal: line.lineTotal,
      qtyLeft,
      serials: (line.serials || []).map(String),
      serialsLeft,
    })),
  };
}

/** One returned line, priced from the bill's line: its whole remaining amount when it is the last of it, else pro rata. */
function creditLine({ line, index, taken }, qty, serials) {
  const total = n(line.qty);
  const last = Math.abs(total - n(taken?.qty) - qty) < EPS;
  const out = {
    billLine: index,
    kind: 'goods',
    name: line.name,
    detail: line.detail || '',
    hsn: line.hsn || '',
    unit: line.unit || '',
    qty,
    rate: line.rate,
    gstPercent: line.gstPercent,
    productId: line.productId,
    batch: line.batch || '',
    batchNo: line.batchNo || '',
    serials,
    priceType: line.priceType,
    ewayBillId: line.ewayBillId || '',
    ewayNo: line.ewayNo || '',
  };
  for (const k of AMOUNTS) {
    const left = round2(n(line[k]) - n(taken?.sums[k]));
    out[k] = last ? left : Math.min(left, round2((n(line[k]) * qty) / total));
  }
  return out;
}

/** The credit note's own pricing, in the shape every document PDF reads (see invoicePricing.service.js). */
function pricingOf(lines, bill) {
  const sum = (key) => round2(lines.reduce((a, l) => a + n(l[key]), 0));
  const byHsn = new Map();
  for (const l of lines) {
    const row = byHsn.get(l.hsn || '—') || { hsn: l.hsn || '—', taxable: 0, gst: 0, rates: new Set() };
    row.taxable = round2(row.taxable + n(l.taxable));
    row.gst = round2(row.gst + n(l.gstAmount));
    if (l.gstPercent) row.rates.add(l.gstPercent);
    byHsn.set(row.hsn, row);
  }
  const gstTotal = sum('gstAmount');
  const withGst = !(bill.pricing?.withGst === false || bill.pricing?.invoiceGstMode === 'without_gst');
  return {
    lines,
    subtotal: sum('amount'),
    discount: round2(sum('gross') - sum('amount')),
    discountIsPercent: false,
    discountAmount: round2(sum('gross') - sum('amount')),
    discountRemark: '',
    taxableTotal: sum('taxable'),
    gstTotal,
    taxByHsn: [...byHsn.values()].map((r) => ({ hsn: r.hsn, taxable: r.taxable, gst: r.gst, rate: r.rates.size === 1 ? [...r.rates][0] : null })),
    gstIncluded: false,
    gstRate: lines.reduce((m, l) => Math.max(m, n(l.gstPercent)), 0),
    total: sum('lineTotal'),
    sgst: round2(gstTotal / 2),
    cgst: round2(gstTotal / 2),
    igst: gstTotal,
    invoiceGstMode: withGst ? 'with_gst' : 'without_gst',
    withGst,
  };
}

export const creditNoteService = {
  /** Every credit note of the company, newest first, paged. */
  async list(company, { page, limit, from, to } = {}) {
    const match = { company: company._id, ...(dateRangeOnField('issuedOn', from, to) || {}) };
    const { page: p, limit: l, skip } = parsePagination({ page, limit });
    const [rows, total] = await Promise.all([
      CreditNote.find(match).sort({ createdAt: -1 }).skip(skip).limit(l).populate('client', 'name').populate('design', 'name').populate('bill', 'billNo').lean(),
      CreditNote.countDocuments(match),
    ]);
    return { items: rows.map(summary), total, page: p, limit: l };
  },

  /** One party's credit notes, newest first — the proposal's or the client's billing page. */
  async forParty(company, party) {
    const rows = await CreditNote.find({ company: company._id, ...partyFilter(party) }).sort({ createdAt: -1 }).populate('bill', 'billNo').lean();
    return rows.map(summary);
  },

  async get(company, id) {
    const row = await CreditNote.findOne({ _id: objectId(id, 'Credit note'), company: company._id })
      .populate('client', 'name phone email address gstNumber').populate('design', 'name').populate('bill', 'billNo issuedOn').populate('invoice', 'invoiceNo').lean();
    if (!row) throw notFound('Credit note');
    return summary(row);
  },

  /**
   * Take goods back on a paid bill. `body.lines` is [{ line, qty | serials }] (`line` = the line's place on the bill, see
   * returnableOf), `body.refund` how the money was paid back, `body.reason` why. One transaction: the goods go back into
   * stock, the refund comes off the bill's payment and the credit note is numbered and stored.
   */
  async create(company, user, billId, body = {}) {
    const reason = String(body.reason || '').trim().slice(0, 300);
    if (!reason) throw badRequest('Give the reason the goods came back');
    const refund = body.refund && typeof body.refund === 'object' ? body.refund : {};
    if (!PAYMENT_MODES.includes(refund.mode)) throw badRequest('Choose how the money was paid back');
    const refundedOn = refund.refundedOn ? new Date(refund.refundedOn) : new Date();
    if (Number.isNaN(refundedOn.getTime())) throw badRequest('Invalid refund date');
    const issuedOn = body.issuedOn ? new Date(body.issuedOn) : new Date();
    if (Number.isNaN(issuedOn.getTime())) throw badRequest('Invalid date');
    const wanted = Array.isArray(body.lines) ? body.lines : [];
    if (!wanted.length) throw badRequest('Choose at least one product to return');
    if (new Set(wanted.map((w) => w.line)).size !== wanted.length) throw badRequest('Each product can be listed once');
    const idempotencyKey = cleanIdempotencyKey(body.idempotencyKey);
    const id = objectId(billId, 'Bill');

    return createOnce(CreditNote, company, idempotencyKey, () => inTransaction(async (session) => {
      const bill = await Bill.findOne({ _id: id, company: company._id }).session(session).lean();
      if (!bill) throw notFound('Bill');
      if (bill.status === 'void') throw badRequest('This bill is void: there is nothing to return');
      const notes = await CreditNote.find({ company: company._id, bill: bill._id }).select('lines').session(session).lean();
      const goods = new Map(goodsOf(bill, notes).map((g) => [g.index, g]));

      const lines = [];
      for (const w of wanted) {
        const g = goods.get(w.line);
        if (!g) throw badRequest('Only the goods on a bill can be returned');
        const serialized = (g.line.serials || []).length > 0;
        let qty;
        let serials = [];
        if (serialized) {
          serials = [...new Set((w.serials || []).map(String))];
          if (!serials.length) throw badRequest(`Choose the serial numbers of ${g.line.name} that came back`);
          const bad = serials.filter((s) => !g.serialsLeft.includes(s));
          if (bad.length) throw badRequest(`${bad.slice(0, 5).join(', ')} ${bad.length === 1 ? 'is' : 'are'} not on this bill or already returned`);
          qty = serials.length;
        } else {
          qty = round2(w.qty);
          if (!(qty > 0)) throw badRequest(`Enter how many ${g.line.name} came back`);
          if (qty - g.qtyLeft > EPS) throw badRequest(`Only ${g.qtyLeft} ${g.line.unit || ''} of ${g.line.name} can still be returned`.replace('  ', ' '));
        }
        lines.push(creditLine(g, qty, serials));
      }

      // the units must still be sold on those e-way bills: one that was installed or returned by hand can't be put back by this
      const byEway = new Map();
      for (const l of lines) if (l.ewayBillId) byEway.set(l.ewayBillId, [...(byEway.get(l.ewayBillId) || []), l]);
      const serialsBack = lines.flatMap((l) => l.serials);
      if (serialsBack.length) {
        const moved = await SerialUnit.find({ company: company._id, serialNo: { $in: serialsBack }, status: { $ne: 'sold' } }).select('serialNo').session(session).lean();
        if (moved.length) throw conflict(`${moved.slice(0, 10).map((u) => u.serialNo).join(', ')} ${moved.length === 1 ? 'is' : 'are'} no longer sold (installed or returned). Put ${moved.length === 1 ? 'it' : 'them'} back in stock first, or leave ${moved.length === 1 ? 'it' : 'them'} off this credit note`);
      }
      for (const [ewayId, group] of byEway) await returnStock(company, group, { ewayBillId: new mongoose.Types.ObjectId(ewayId), session });

      const pricing = pricingOf(lines, bill);
      const total = round2(pricing.total);
      if (!(total > 0)) throw badRequest('The credit note total must be greater than zero');
      if (round2(n(bill.creditedTotal) + total) - n(bill.total) > 0.01) throw conflict('That is more than this bill’s total. Refresh and try again');

      // the refund comes off the payment of the bill; a payment paid back in full is removed (the bill keeps what was paid)
      let payment = bill.payment;
      if (bill.payment) {
        const row = await Payment.findOne({ _id: bill.payment, company: company._id }).session(session);
        if (row) {
          const left = round2(n(row.amount) - total);
          if (left < -0.01) throw conflict('The payment held for this bill is less than the refund. Refresh and try again');
          if (left < 0.01) {
            await Payment.deleteOne({ _id: row._id }, { session });
            payment = null;
          } else {
            await Payment.updateOne({ _id: row._id }, { $set: { amount: left }, $inc: { refunded: total } }, { session });
          }
        }
      }
      await Bill.updateOne({ _id: bill._id }, { $inc: { creditedTotal: total }, $set: { payment } }, { session });

      const [created] = await CreditNote.create([{
        company: company._id,
        design: bill.design,
        client: bill.client,
        bill: bill._id,
        invoice: bill.invoice || null,
        creditNo: await nextDocumentNumber(company, 'creditnote', 'CN', session),
        issuedOn,
        title: bill.title,
        reason,
        lines,
        pricing,
        total,
        refund: { amount: total, mode: refund.mode, reference: String(refund.reference || '').trim().slice(0, 80), refundedOn, note: String(refund.note || '').trim().slice(0, 300) },
        createdByName: user?.name || user?.email || '',
        idempotencyKey: idempotencyKey || undefined,
      }], { session });
      return summary(created.toObject());
    }), summary);
  },

  async attachPdf(company, id, pdfName) {
    if (!pdfName) throw badRequest('Upload a PDF');
    return archivePdfOnce(CreditNote, 'Credit note', company, id, pdfName);
  },
};

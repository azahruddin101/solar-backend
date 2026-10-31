// Bills: the second document of the sale chain. A bill gathers one or more open e-way bills of the same proposal (or
// client) and any service charges, is priced with GST and an optional discount, and is paid in full when it is made —
// the payment is recorded as a Payment row too (under the bill's number), so the ledger and dashboards count it.
import mongoose from 'mongoose';
import { PAYMENT_MODES } from '../constants/index.js';
import { Bill, Design, EwayBill, InstallationCharge, Invoice, Payment, SerialUnit } from '../models/index.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import { parsePagination, toApiJSON } from '../utils/lean.js';
import { dateRangeOnField } from '../utils/listFilters.js';
import { cleanIdempotencyKey, createOnce } from '../utils/idempotency.js';
import { objectId } from '../utils/validators.js';
import { archivePdfOnce } from './archivePdf.service.js';
import { nextDocumentNumber, partyFilter, resolveParty } from './ewayBill.service.js';
import { authorityInvoicePricing } from './invoicePricing.service.js';
import { inTransaction, returnStock } from './stock.service.js';

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const n = (v) => Number(v) || 0;

/** The saved grand total of a proposal (same rule as billing.service.js totalOf). */
const totalOf = (design) => money(design?.summary?.pricing?.total ?? design?.summary?.cost);

/**
 * Service lines from the form. One picked from the company's installation charges copies its name and SAC; the price,
 * GST and quantity are whatever was typed. A service without a SAC prints none (the column shows a dash). Returns the stored services and the pricing lines they become.
 */
async function cleanServices(company, input, session) {
  const list = Array.isArray(input) ? input : [];
  if (list.length > 50) throw badRequest('Up to 50 services on a bill');
  const ids = list.map((s) => s?.chargeId).filter((id) => /^[0-9a-f]{24}$/i.test(String(id || '')));
  const charges = ids.length ? await InstallationCharge.find({ _id: { $in: ids }, company: company._id }).session(session).lean() : [];
  const byId = new Map(charges.map((c) => [String(c._id), c]));
  const services = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const charge = byId.get(String(s.chargeId || ''));
    const name = String(s.name || charge?.name || '').trim().slice(0, 160);
    if (!name) throw badRequest('Give every service a name');
    const qty = s.qty === '' || s.qty == null ? 1 : Number(s.qty);
    const rate = Number(s.rate);
    const gstPercent = s.gstPercent === '' || s.gstPercent == null ? (charge?.gstPercent ?? 18) : Number(s.gstPercent);
    if (!Number.isFinite(qty) || qty <= 0) throw badRequest(`Enter the quantity of ${name}`);
    if (!Number.isFinite(rate) || rate < 0) throw badRequest(`Enter the price of ${name}`);
    if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 100) throw badRequest(`GST % of ${name} must be between 0 and 100`);
    services.push({
      chargeId: charge?._id ?? null,
      name,
      description: String(s.description || '').trim().slice(0, 300),
      hsn: String(s.hsn ?? charge?.sac ?? '').replace(/\D/g, '').slice(0, 8),
      qty,
      unit: String(s.unit || 'Nos').trim().slice(0, 20) || 'Nos',
      rate: money(rate),
      gstPercent,
    });
  }
  return services;
}

const serviceLine = (s) => ({ kind: 'service', name: s.name, detail: s.description, hsn: s.hsn, qty: s.qty, unit: s.unit, rate: s.rate, gstPercent: s.gstPercent });
const goodsLines = (ewayBill) => (ewayBill.pricing?.lines || ewayBill.lines || []).map((l) => ({ ...l, kind: 'goods', ewayBillId: String(ewayBill._id), ewayNo: ewayBill.ewayNo }));

const summary = (row) => toApiJSON(row);

export const billService = {
  /** Every bill of the company, newest first, paged; `status` and the issue-date range are optional. */
  async list(company, { page, limit, from, to, status } = {}) {
    const match = { company: company._id, ...(status ? { status } : {}), ...(dateRangeOnField('issuedOn', from, to) || {}) };
    const { page: p, limit: l, skip } = parsePagination({ page, limit });
    const [rows, total] = await Promise.all([
      Bill.find(match).sort({ createdAt: -1 }).skip(skip).limit(l).populate('client', 'name').populate('design', 'name').populate('ewayBills', 'ewayNo').populate('invoice', 'invoiceNo').lean(),
      Bill.countDocuments(match),
    ]);
    return { items: rows.map(summary), total, page: p, limit: l };
  },

  /** One party's bills, newest first — the proposal's or the client's billing page. */
  async forParty(company, party) {
    const rows = await Bill.find({ company: company._id, ...partyFilter(party) }).sort({ createdAt: -1 }).populate('ewayBills', 'ewayNo issuedOn total').populate('invoice', 'invoiceNo').lean();
    return rows.map(summary);
  },

  /** The paid, not yet invoiced bills an invoice can be made for. */
  async uninvoiced(company, { design, client }) {
    const party = await resolveParty(company, { design, client });
    const rows = await Bill.find({ company: company._id, ...partyFilter(party), status: 'paid' }).sort({ createdAt: 1 }).populate('ewayBills', 'ewayNo issuedOn total').lean();
    return rows.map(summary);
  },

  async get(company, id) {
    const row = await Bill.findOne({ _id: objectId(id, 'Bill'), company: company._id })
      .populate('client', 'name phone email address gstNumber')
      .populate('design', 'name')
      .populate('ewayBills', 'ewayNo govtEwayNo issuedOn total transport')
      .populate('invoice', 'invoiceNo')
      .lean();
    if (!row) throw notFound('Bill');
    return summary(row);
  },

  /**
   * Generate a bill for a party: its open e-way bills (`ewayBills`, ids) and/or `services`, priced with `withGst` and an
   * optional discount, paid now (`payment`: mode, reference, receivedOn, note). In one transaction the e-way bills are
   * marked billed, the bill is inserted, and the payment of the bill total is recorded. With an `idempotencyKey`,
   * repeating the request returns the bill and payment it made instead of recording the payment again.
   */
  async create(company, user, body = {}) {
    const wantIds = [...new Set((Array.isArray(body.ewayBills) ? body.ewayBills : []).map((id) => String(id)))];
    const withGst = body.withGst !== false;
    const payment = body.payment && typeof body.payment === 'object' ? body.payment : {};
    if (!PAYMENT_MODES.includes(payment.mode)) throw badRequest('Choose how the bill was paid');
    const receivedOn = payment.receivedOn ? new Date(payment.receivedOn) : new Date();
    if (Number.isNaN(receivedOn.getTime())) throw badRequest('Invalid payment date');
    const issuedOn = body.issuedOn ? new Date(body.issuedOn) : new Date();
    if (Number.isNaN(issuedOn.getTime())) throw badRequest('Invalid date');
    const discount = Math.max(0, Number(body.discount) || 0);
    const discountIsPercent = Boolean(body.discountIsPercent);
    if (discountIsPercent && discount > 100) throw badRequest('A percentage discount can be at most 100%');

    const idempotencyKey = cleanIdempotencyKey(body.idempotencyKey);
    // a repeated request (same key) gets the bill and payment the first one made
    const replay = async (row) => {
      const [ewayBills, paymentRow] = await Promise.all([
        EwayBill.find({ _id: { $in: row.ewayBills || [] } }).select('ewayNo issuedOn total').lean(),
        row.payment ? Payment.findById(row.payment).lean() : null,
      ]);
      return { bill: summary({ ...row, ewayBills }), payment: toApiJSON(paymentRow) };
    };

    return createOnce(Bill, company, idempotencyKey, () => inTransaction(async (session) => {
      const party = await resolveParty(company, body, session);
      const services = await cleanServices(company, body.services, session);
      if (!wantIds.length && !services.length) throw badRequest('Choose at least one e-way bill or add a service');
      const ewayBills = wantIds.length
        ? await EwayBill.find({ _id: { $in: wantIds.map((id) => objectId(id, 'E-way bill')) }, company: company._id, ...partyFilter(party) }).sort({ createdAt: 1 }).session(session).lean()
        : [];
      if (ewayBills.length !== wantIds.length) throw notFound('E-way bill');
      const notOpen = ewayBills.filter((e) => e.status !== 'open');
      if (notOpen.length) throw conflict(`${notOpen.map((e) => e.ewayNo).join(', ')} ${notOpen.length === 1 ? 'is' : 'are'} already on a bill or cancelled`);

      const lines = [...ewayBills.flatMap(goodsLines), ...services.map(serviceLine)];
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
      const billId = new mongoose.Types.ObjectId();
      const billNo = await nextDocumentNumber(company, 'bill', 'BILL', session);

      if (ewayBills.length) {
        const marked = await EwayBill.updateMany({ _id: { $in: ewayBills.map((e) => e._id) }, status: 'open' }, { $set: { status: 'billed', bill: billId } }, { session });
        if (marked.modifiedCount !== ewayBills.length) throw conflict('One of these e-way bills was just billed. Refresh and try again');
      }

      // the payment row: on a proposal it moves the proposal's balance; on a client alone it stands by itself
      let contractTotal = total;
      let balanceAfter = 0;
      if (party.design) {
        const design = await Design.findById(party.design._id).select('summary').session(session).lean();
        const paidBefore = (await Payment.aggregate([{ $match: { company: company._id, design: party.design._id } }, { $group: { _id: null, paid: { $sum: '$amount' } } }]).session(session))[0]?.paid || 0;
        contractTotal = totalOf(design);
        balanceAfter = money(contractTotal - paidBefore - total);
      }
      const [paymentRow] = await Payment.create([{
        company: company._id,
        design: party.design?._id ?? null,
        client: party.client._id,
        bill: billId,
        receiptNo: billNo, // the bill is the payment document
        title: party.design ? '' : `Bill ${billNo}`,
        billTo: party.design ? null : { name: party.client.name },
        amount: total,
        mode: payment.mode,
        reference: String(payment.reference || '').trim().slice(0, 80),
        receivedOn,
        note: [`Bill ${billNo}`, String(payment.note || '').trim()].filter(Boolean).join(' · ').slice(0, 300),
        contractTotal,
        balanceAfter,
        createdByName: user?.name || user?.email || '',
      }], { session });

      const [created] = await Bill.create([{
        _id: billId,
        company: company._id,
        design: party.design?._id ?? null,
        client: party.client._id,
        billNo,
        issuedOn,
        title: party.title,
        ewayBills: ewayBills.map((e) => e._id),
        services,
        pricing,
        total,
        paid: { amount: total, mode: payment.mode, reference: String(payment.reference || '').trim().slice(0, 80), receivedOn, note: String(payment.note || '').trim().slice(0, 300) },
        payment: paymentRow._id,
        createdByName: user?.name || user?.email || '',
        idempotencyKey: idempotencyKey || undefined,
      }], { session });
      const out = created.toObject();
      out.ewayBills = ewayBills.map((e) => ({ _id: e._id, ewayNo: e.ewayNo, issuedOn: e.issuedOn, total: e.total }));
      return { bill: summary(out), payment: toApiJSON(paymentRow.toObject()) };
    }), replay);
  },

  /**
   * Void a bill that is not on an invoice (void the invoice first). The bill stays as the record, with who voided it and
   * why; its payment row is removed, so every ledger and dashboard drops the money at once. Its e-way bills open again,
   * or, with `returnStock`, are cancelled and their goods go back into stock. Bill numbers are never reused.
   */
  async void(company, user, id, body = {}) {
    const reason = String(body.reason || '').trim().slice(0, 300);
    if (!reason) throw badRequest('Give the reason for voiding this bill');
    const returnGoods = Boolean(body.returnStock);
    return inTransaction(async (session) => {
      const bill = await Bill.findOne({ _id: objectId(id, 'Bill'), company: company._id }).session(session);
      if (!bill) throw notFound('Bill');
      if (bill.status === 'void') throw badRequest('This bill is already void');
      if (n(bill.creditedTotal) > 0) throw conflict(`Goods have already been returned on bill ${bill.billNo} (a credit note). It can't be voided; the rest of it stands`);
      if (bill.status === 'invoiced' || bill.invoice) {
        const invoice = bill.invoice ? await Invoice.findById(bill.invoice).select('invoiceNo').session(session).lean() : null;
        throw conflict(`Bill ${bill.billNo} is on invoice ${invoice?.invoiceNo || ''}. Void that invoice first`.replace('  ', ' '));
      }
      const ewayBills = await EwayBill.find({ _id: { $in: bill.ewayBills || [] }, company: company._id, bill: bill._id, status: 'billed' }).session(session);
      if (returnGoods && ewayBills.length) {
        // a unit that was installed or returned since can't be put back by this: say so instead of returning too few
        const moved = await SerialUnit.find({ company: company._id, soldEwayBill: { $in: ewayBills.map((e) => e._id) }, status: { $ne: 'sold' } }).select('serialNo').session(session).lean();
        if (moved.length) throw conflict(`${moved.slice(0, 10).map((u) => u.serialNo).join(', ')} ${moved.length === 1 ? 'is' : 'are'} no longer sold (installed or returned). Void without returning stock, or put ${moved.length === 1 ? 'it' : 'them'} back in stock first`);
      }
      if (bill.payment) await Payment.deleteOne({ _id: bill.payment, company: company._id }, { session });
      for (const e of ewayBills) {
        if (returnGoods) {
          await returnStock(company, e.lines, { ewayBillId: e._id, session });
          await EwayBill.updateOne({ _id: e._id }, { $set: { status: 'cancelled', bill: null, cancelledAt: new Date(), cancelReason: `Bill ${bill.billNo} voided: ${reason}`.slice(0, 300) } }, { session });
        } else {
          await EwayBill.updateOne({ _id: e._id }, { $set: { status: 'open', bill: null } }, { session });
        }
      }
      const voided = await Bill.findOneAndUpdate(
        { _id: bill._id, status: 'paid' },
        { $set: { status: 'void', payment: null, voidedAt: new Date(), voidReason: reason, voidedByName: user?.name || user?.email || '' } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!voided) throw conflict('This bill was just changed. Refresh and try again');
      return summary(voided);
    });
  },

  async attachPdf(company, id, pdfName) {
    if (!pdfName) throw badRequest('Upload a PDF');
    return archivePdfOnce(Bill, 'Bill', company, id, pdfName);
  },
};

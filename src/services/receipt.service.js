// Receipts: money a client hands over, at any time and for any amount. Each one is a Payment row with no `bill`
// (payment.model.js), numbered RCPT-0001…, so every ledger and dashboard that sums payments counts it. What a party
// still owes is what was billed to it (its bills) minus what its receipts add up to.
import { PAYMENT_MODES } from '../constants/index.js';
import { Bill, EwayBill, Payment } from '../models/index.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { parsePagination, toApiJSON } from '../utils/lean.js';
import { dateRangeOnField } from '../utils/listFilters.js';
import { cleanIdempotencyKey, createOnce } from '../utils/idempotency.js';
import { objectId } from '../utils/validators.js';
import { archivePdfOnce } from './archivePdf.service.js';
import { nextDocumentNumber, partyFilter, resolveParty } from './ewayBill.service.js';
import { inTransaction } from './stock.service.js';
import { deleteFile } from './storage.service.js';

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const DAY = 24 * 60 * 60 * 1000;

/** Payment rows that are receipts (not the payment of an older invoice). */
const RECEIPT = { bill: null, ewayBill: null };

/**
 * What has been billed to a party: its bills that stand (EwayBill rows still open) plus its older invoices (Bill rows
 * not void), which carry the bills they covered. Cancelled and revised bills count for nothing.
 */
export function billedTotal(ewayBills = [], bills = []) {
  const open = ewayBills.filter((e) => e.status === 'open').reduce((a, e) => a + (Number(e.total) || 0), 0);
  const invoiced = bills.filter((b) => b.status !== 'void').reduce((a, b) => a + (Number(b.total) || 0), 0);
  return money(open + invoiced);
}

/** `billedTotal` of one party, read inside `session`. */
async function partyBilled(company, party, session) {
  const match = { company: company._id, ...partyFilter(party) };
  const [ewayBills, bills] = await Promise.all([
    EwayBill.find({ ...match, status: 'open' }).select('status total').session(session).lean(),
    Bill.find({ ...match, status: { $ne: 'void' } }).select('status total').session(session).lean(),
  ]);
  return billedTotal(ewayBills, bills);
}

/**
 * How many parties (booked proposals, or clients billed with no proposal) still owe money in each company: billed more
 * than received. Returns `(companyId) => count`.
 */
export async function partiesWithDue(companyIds) {
  const match = { company: { $in: companyIds } };
  const party = { company: '$company', design: '$design', client: { $cond: [{ $eq: ['$design', null] }, '$client', null] } };
  const [open, invoiced, received] = await Promise.all([
    EwayBill.aggregate([{ $match: { ...match, status: 'open' } }, { $group: { _id: party, sum: { $sum: '$total' } } }]),
    Bill.aggregate([{ $match: { ...match, status: { $ne: 'void' } } }, { $group: { _id: party, sum: { $sum: '$total' } } }]),
    Payment.aggregate([{ $match: match }, { $group: { _id: party, sum: { $sum: '$amount' } } }]),
  ]);
  const key = (id) => `${id.company}:${id.design || ''}:${id.client || ''}`;
  const due = new Map();
  for (const x of [...open, ...invoiced]) due.set(key(x._id), (due.get(key(x._id)) || 0) + x.sum);
  for (const x of received) if (due.has(key(x._id))) due.set(key(x._id), due.get(key(x._id)) - x.sum);
  const counts = new Map();
  for (const [k, v] of due) {
    if (v <= 0.005) continue;
    const company = k.slice(0, k.indexOf(':'));
    counts.set(company, (counts.get(company) || 0) + 1);
  }
  return (id) => counts.get(String(id)) || 0;
}

export const receiptService = {
  /** Every receipt of the company, newest first, paged; the received-date range is optional. */
  async list(company, { page, limit, from, to } = {}) {
    const match = { company: company._id, ...RECEIPT, ...(dateRangeOnField('receivedOn', from, to) || {}) };
    const { page: p, limit: l, skip } = parsePagination({ page, limit });
    const [rows, total] = await Promise.all([
      Payment.find(match).sort({ receivedOn: -1, createdAt: -1 }).skip(skip).limit(l).populate('client', 'name phone email address gstNumber').populate('design', 'name').lean(),
      Payment.countDocuments(match),
    ]);
    return { items: rows.map(toApiJSON), total, page: p, limit: l };
  },

  /** One party's receipts, newest first — the proposal's or the client's billing page. */
  async forParty(company, party) {
    const rows = await Payment.find({ company: company._id, ...partyFilter(party), ...RECEIPT }).sort({ receivedOn: -1, createdAt: -1 }).lean();
    return rows.map(toApiJSON);
  },

  /**
   * Record money received from a party (a booked proposal, or a client alone): `amount`, `mode`, optional `reference`,
   * `receivedOn` (today when left out), `receivedBy` (the signed-in user when left out) and an optional `reason`.
   * Any amount is accepted: part of what is due, all of it, or an advance before anything is billed. With an
   * `idempotencyKey`, repeating the request returns the receipt it made instead of recording the money twice.
   */
  async create(company, user, body = {}) {
    const amount = money(body.amount);
    if (!(amount > 0)) throw badRequest('Enter the amount received');
    if (!PAYMENT_MODES.includes(body.mode)) throw badRequest('Choose how the money was received');
    const receivedOn = body.receivedOn ? new Date(body.receivedOn) : new Date();
    if (Number.isNaN(receivedOn.getTime())) throw badRequest('Invalid date');
    if (receivedOn.getTime() > Date.now() + DAY) throw badRequest('The receipt date can’t be in the future');
    const staff = user?.name || user?.email || '';
    const receivedByName = String(body.receivedBy || '').trim().slice(0, 120) || staff;
    const idempotencyKey = cleanIdempotencyKey(body.idempotencyKey);

    return createOnce(Payment, company, idempotencyKey, () => inTransaction(async (session) => {
      const party = await resolveParty(company, body, session);
      const [billed, before] = await Promise.all([
        partyBilled(company, party, session),
        Payment.aggregate([{ $match: { company: company._id, ...partyFilter(party) } }, { $group: { _id: null, paid: { $sum: '$amount' } } }]).session(session),
      ]);
      const [row] = await Payment.create([{
        company: company._id,
        design: party.design?._id ?? null,
        client: party.client._id,
        bill: null,
        billTo: { name: party.client.name },
        title: party.title,
        receiptNo: await nextDocumentNumber(company, 'receipt', 'RCPT', session),
        amount,
        mode: body.mode,
        reference: String(body.reference || '').trim().slice(0, 80),
        receivedOn,
        reason: String(body.reason || '').trim().slice(0, 300),
        receivedByName,
        contractTotal: billed,
        balanceAfter: money(billed - (before[0]?.paid || 0) - amount),
        createdByName: staff,
        idempotencyKey: idempotencyKey || undefined,
      }], { session });
      return toApiJSON(row.toObject());
    }), toApiJSON);
  },

  /**
   * Remove a receipt recorded by mistake (the company owner only): the money comes off the books at once and the
   * number is not reused. The payment of an older invoice is not a receipt: void that invoice instead.
   */
  async remove(company, id) {
    const row = await Payment.findOne({ _id: objectId(id, 'Receipt'), company: company._id }).lean();
    if (!row) throw notFound('Receipt');
    if (row.bill) throw badRequest(`${row.receiptNo} is the payment of an invoice. Void that invoice instead`);
    if (row.ewayBill) throw badRequest(`${row.receiptNo} is the payment of a bill. Cancel that bill instead`);
    await Payment.deleteOne({ _id: row._id, company: company._id });
    if (row.pdfName) await deleteFile(row.pdfName).catch(() => {});
    return { ok: true, receiptNo: row.receiptNo };
  },

  async attachPdf(company, id, pdfName) {
    if (!pdfName) throw badRequest('Upload a PDF');
    return archivePdfOnce(Payment, 'Receipt', company, id, pdfName);
  },
};

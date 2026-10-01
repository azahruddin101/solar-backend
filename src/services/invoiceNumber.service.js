// Invoice numbers: a company-chosen fixed part plus a running number, e.g. INVCMP2026 + 0001 → INVCMP20260001.
// The running number lives on the company (`invoiceNumbering.next`) and is reserved with an atomic $inc, so two
// invoices generated at the same moment can never get the same number. The unique index on {company, invoiceNo}
// is the final guard: a clash (e.g. the owner moved the counter back over numbers that already exist) is skipped.
import { Company, Counter, Invoice } from '../models/index.js';
import { badRequest } from '../utils/HttpError.js';

export const DEFAULT_PREFIX = 'INV-';
export const DEFAULT_WIDTH = 4;
export const MAX_PREFIX = 20;
export const MAX_WIDTH = 10;
/** Letters, digits and - / _ . (GST allows letters, digits, - and / in a serial number). */
export const PREFIX_RE = /^[A-Za-z0-9/_.-]*$/;
const DIGITS_RE = /^\d{1,10}$/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** 7 with width 4 → "0007"; the width is a minimum, so 10000 with width 4 stays "10000" (numbers never wrap). */
export const formatInvoiceNo = ({ prefix = DEFAULT_PREFIX, width = DEFAULT_WIDTH } = {}, seq) => `${prefix}${String(seq).padStart(width, '0')}`;

/** Companies created before numbering was configurable continue the old per-company counter. */
async function legacyNextSeq(company) {
  if (company.isNew) return 1; // not saved yet: nothing was ever issued
  const c = await Counter.findOne({ company: company._id, key: 'invoice' }).lean();
  return (c?.seq || 0) + 1;
}

/** The number the next invoice will get (nothing is reserved). */
export async function peekInvoiceNo(company) {
  const n = company.invoiceNumbering || {};
  return formatInvoiceNo(n, n.next ?? (await legacyNextSeq(company)));
}

/** Highest running number already used under `prefix` for this company, or 0. */
export async function highestUsedSeq(company, prefix) {
  const rows = await Invoice.find({ company: company._id, invoiceNo: new RegExp(`^${escapeRe(prefix)}\\d+$`) }).select('invoiceNo').lean();
  let max = 0;
  for (const r of rows) {
    const seq = Number(r.invoiceNo.slice(prefix.length));
    if (seq > max) max = seq;
  }
  return max;
}

/**
 * Settings input → stored numbering. `next` is typed with its leading zeros ("0001"): that fixes the width.
 * Refuses a start that would reuse a number already issued under the same prefix.
 */
export async function parseInvoiceNumbering(company, input) {
  if (!input || typeof input !== 'object') throw badRequest('Invalid invoice numbering');
  const prefix = String(input.prefix ?? '').trim();
  const nextStr = String(input.next ?? '').trim();
  if (prefix.length > MAX_PREFIX) throw badRequest(`The fixed part can be at most ${MAX_PREFIX} characters`);
  if (!PREFIX_RE.test(prefix)) throw badRequest('The fixed part can only have letters, digits and - / _ .');
  if (!DIGITS_RE.test(nextStr)) throw badRequest('Enter the next number as digits only, like 0001');
  const next = Number(nextStr);
  if (!(next >= 1)) throw badRequest('The next number must be at least 1');
  const width = Math.min(nextStr.length, MAX_WIDTH);
  const used = await highestUsedSeq(company, prefix);
  if (next <= used) {
    throw badRequest(`${formatInvoiceNo({ prefix, width }, next)} is already used. Numbers up to ${formatInvoiceNo({ prefix, width }, used)} exist, so start from ${formatInvoiceNo({ prefix, width }, used + 1)} or later`);
  }
  return { prefix, width, next };
}

/** Atomically take the next number for `company`. Each call returns a new number, even under concurrent requests. */
export async function reserveInvoiceNo(company) {
  // One-time seeding for legacy companies (`next` still null): continue from the old counter. The filter makes the
  // seeding itself race-free — only one of several concurrent first calls can match `next: null`.
  if (company.invoiceNumbering?.next == null) {
    await Company.updateOne({ _id: company._id, 'invoiceNumbering.next': null }, { $set: { 'invoiceNumbering.next': await legacyNextSeq(company) } });
  }
  const before = await Company.findOneAndUpdate(
    { _id: company._id, 'invoiceNumbering.next': { $type: 'number' } },
    { $inc: { 'invoiceNumbering.next': 1 } },
    { returnDocument: 'before', projection: { invoiceNumbering: 1 } },
  );
  if (!before) throw badRequest('Invoice numbering is not set up for this company');
  return formatInvoiceNo(before.invoiceNumbering, before.invoiceNumbering.next);
}

const MAX_ATTEMPTS = 50;
const isDuplicateNo = (e) => e?.code === 11000 && (e?.keyPattern?.invoiceNo || /invoiceNo/.test(e?.message || ''));

/**
 * Create an invoice with the next free number. If a reserved number already exists (the owner pointed the counter
 * at numbers that were issued earlier), it is skipped and the next one is tried.
 */
export async function createNumberedInvoice(company, fields) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const invoiceNo = await reserveInvoiceNo(company);
    try {
      return await Invoice.create({ ...fields, invoiceNo });
    } catch (e) {
      if (!isDuplicateNo(e)) throw e;
    }
  }
  throw badRequest('Could not find a free invoice number. Check the invoice numbering in Settings');
}

// Authoritative invoice line math (mirrors frontend/src/lib/pricing.js summarizeLinePricing).
// Amounts are always qty × rate — client-supplied line amounts and totals are never trusted.
import { badRequest } from '../utils/HttpError.js';

const n = (v) => Number(v) || 0;
const round2 = (v) => Math.round(n(v) * 100) / 100;

function lineGstPercent(line, fallback = 18) {
  const v = line?.gstPercent;
  if (v === null || v === undefined || v === '') return fallback;
  const pct = Number(v);
  if (Number.isNaN(pct)) return fallback;
  return Math.max(0, Math.min(100, pct));
}

/**
 * What a stock line (stock.service.js allocateInvoiceLines) keeps: copies of the product, batch, serials and the price
 * type it was billed at — values, so a later batch edit never changes an issued invoice.
 */
function stockFields(l) {
  if (!l.productId) return {};
  return {
    productId: String(l.productId),
    batch: l.batch ? String(l.batch) : '',
    batchNo: String(l.batchNo || '').slice(0, 60),
    serials: Array.isArray(l.serials) ? l.serials.map(String) : [],
    priceType: l.priceType,
  };
}

/** Where a line of the sale chain came from: the e-way bill and bill it was on (strings, kept for the PDFs). */
function chainFields(l) {
  const out = {};
  if (l.kind === 'service' || l.kind === 'goods') out.kind = l.kind;
  for (const k of ['ewayBillId', 'ewayNo', 'billId', 'billNo']) if (l[k]) out[k] = String(l[k]).slice(0, 40);
  return out;
}

function normalizeLine(l) {
  const qty = Math.max(0, n(l.qty) || 1);
  const rate = round2(l.rate);
  const amount = round2(qty * rate);
  return {
    ...stockFields(l),
    ...chainFields(l),
    name: String(l.name || '').trim().slice(0, 160),
    detail: String(l.detail || '').slice(0, 300),
    hsn: String(l.hsn || l.hsnCode || '').slice(0, 20),
    qty,
    unit: String(l.unit || 'Nos').slice(0, 20),
    rate,
    amount,
    gstPercent: l.gstPercent != null && l.gstPercent !== ''
      ? Math.max(0, Math.min(100, n(l.gstPercent)))
      : undefined,
  };
}

/** Per-line GST with optional discount on the line subtotal (same rules as the invoice UI). */
export function summarizeLinePricing({ lines = [], gstIncluded = true, discount = 0, discountIsPercent = false, withGst = true }) {
  const raw = (lines || [])
    .map((l) => normalizeLine({ ...l, gstPercent: lineGstPercent(l, 18) }))
    .filter((l) => l.name);
  const gross = raw.reduce((a, l) => a + l.amount, 0);
  let discountAmount = discountIsPercent ? gross * (n(discount) / 100) : n(discount);
  discountAmount = round2(Math.min(gross, Math.max(0, discountAmount)));
  const ratio = gross > 0 ? (gross - discountAmount) / gross : 1;

  // each line keeps `gross` (qty × rate as entered); `amount` is its share after the discount, which GST is worked out on
  const processed = raw.map((l) => {
    const lineGross = round2(l.amount * ratio);
    const catalogPct = l.gstPercent ?? 18;
    const pct = withGst ? catalogPct : 0;
    if (gstIncluded && pct > 0) {
      const taxable = round2(lineGross / (1 + pct / 100));
      const gst = round2(lineGross - taxable);
      return { ...l, gross: l.amount, gstPercent: catalogPct, amount: lineGross, taxable, gstAmount: gst, lineTotal: lineGross };
    }
    if (!gstIncluded && pct > 0) {
      const taxable = lineGross;
      const gst = round2(taxable * (pct / 100));
      return { ...l, gross: l.amount, gstPercent: catalogPct, amount: lineGross, taxable, gstAmount: gst, lineTotal: round2(taxable + gst) };
    }
    return { ...l, gross: l.amount, gstPercent: catalogPct, amount: lineGross, taxable: lineGross, gstAmount: 0, lineTotal: lineGross };
  });

  const subtotal = round2(processed.reduce((a, l) => a + l.amount, 0));
  const taxableTotal = round2(processed.reduce((a, l) => a + l.taxable, 0));
  const gstTotal = round2(processed.reduce((a, l) => a + l.gstAmount, 0));
  const total = gstIncluded ? subtotal : round2(taxableTotal + gstTotal);

  const byHsn = new Map();
  for (const l of processed) {
    const key = l.hsn || '—';
    const row = byHsn.get(key) || { hsn: key, taxable: 0, gst: 0, rates: new Set() };
    row.taxable = round2(row.taxable + l.taxable);
    row.gst = round2(row.gst + l.gstAmount);
    if (l.gstPercent) row.rates.add(l.gstPercent);
    byHsn.set(key, row);
  }
  const taxByHsn = [...byHsn.values()].map((r) => ({
    hsn: r.hsn,
    taxable: r.taxable,
    gst: r.gst,
    rate: r.rates.size === 1 ? [...r.rates][0] : null,
  }));

  const maxRate = processed.reduce((m, l) => Math.max(m, lineGstPercent(l, 0)), 0);

  return {
    lines: processed,
    subtotal,
    discountAmount,
    discountIsPercent: Boolean(discountIsPercent),
    discount: n(discount),
    taxableTotal,
    gstTotal,
    gstIncluded: gstIncluded !== false,
    gstRate: maxRate,
    taxByHsn,
    total,
    sgst: round2(gstTotal / 2),
    cgst: round2(gstTotal / 2),
    igst: gstTotal,
  };
}

/**
 * Recompute invoice pricing from line inputs. Returns the stored shape with an authoritative `total`.
 * @param {object} input — pricing payload from the client (lines required)
 */
export function authorityInvoicePricing(input) {
  if (!input || typeof input !== 'object') throw badRequest('Invalid pricing');
  const lines = input.lines;
  if (!Array.isArray(lines) || !lines.some((l) => String(l?.name || '').trim())) throw badRequest('Add at least one line item');

  const applyGst = input.withGst !== false && input.invoiceGstMode !== 'without_gst';
  const gstIncluded = input.gstIncluded !== false;
  // two discounts: the proposal's (carried over as is) and an extra one on the invoice, taken after it
  const parts = splitDiscounts(lines, gstIncluded, applyGst, input);
  const summary = summarizeLinePricing({
    lines,
    gstIncluded,
    discount: parts.total,
    discountIsPercent: false,
    withGst: applyGst,
  });

  if (!(summary.total > 0)) throw badRequest('Invoice total must be greater than zero');

  return {
    lines: summary.lines,
    subtotal: summary.subtotal,
    discountAmount: summary.discountAmount,
    discount: n(input.discount),
    discountIsPercent: Boolean(input.discountIsPercent),
    discountRemark: String(input.discountRemark || '').slice(0, 200),
    proposalDiscountAmount: parts.first,
    extraDiscount: n(input.extraDiscount),
    extraDiscountIsPercent: Boolean(input.extraDiscountIsPercent),
    extraDiscountRemark: String(input.extraDiscountRemark || '').slice(0, 200),
    extraDiscountAmount: parts.extra,
    taxableTotal: summary.taxableTotal,
    gstTotal: summary.gstTotal,
    taxByHsn: summary.taxByHsn,
    gstIncluded: summary.gstIncluded,
    gstRate: summary.gstRate,
    total: summary.total,
    invoiceGstMode: input.invoiceGstMode || (applyGst ? 'with_gst' : 'without_gst'),
    withGst: applyGst,
    paymentTerms: String(input.paymentTerms || '').slice(0, 120),
  };
}

/**
 * The proposal's discount on the line subtotal, then the invoice's extra discount on what is left; each flat or %.
 * Returns the two amounts and their sum (never more than the subtotal).
 */
export function splitDiscounts(lines, gstIncluded, withGst, input = {}) {
  const gross = summarizeLinePricing({ lines, gstIncluded, discount: 0, withGst }).subtotal;
  const amountOf = (base, value, pct) => round2(Math.min(base, Math.max(0, pct ? base * (n(value) / 100) : n(value))));
  const first = amountOf(gross, input.discount, input.discountIsPercent);
  const extra = amountOf(gross - first, input.extraDiscount, input.extraDiscountIsPercent);
  return { gross, first, extra, total: round2(first + extra) };
}

/**
 * One pricing for an invoice that settles several bills: their frozen lines one after another (each tagged with its
 * bill number) and their totals added up — nothing is recomputed, so the invoice total is exactly what was paid on the
 * bills, whatever their GST rates and discounts. A bill made without GST keeps its lines at 0 % GST; the invoice is a
 * tax invoice as soon as any bill carried GST.
 */
export function consolidatePricing(bills) {
  if (!bills?.length) throw badRequest('There is no paid bill to invoice yet');
  const withGst = bills.some((b) => !(b.pricing?.withGst === false || b.pricing?.invoiceGstMode === 'without_gst'));
  const sum = (key) => round2(bills.reduce((a, b) => a + n(b.pricing?.[key]), 0));
  const lines = bills.flatMap((b) => (b.pricing?.lines || []).map((l) => ({ ...l, billId: String(b._id || b.id), billNo: b.billNo })));
  const byHsn = new Map();
  for (const b of bills) {
    for (const r of b.pricing?.taxByHsn || []) {
      const row = byHsn.get(r.hsn) || { hsn: r.hsn, taxable: 0, gst: 0, rates: new Set() };
      row.taxable = round2(row.taxable + n(r.taxable));
      row.gst = round2(row.gst + n(r.gst));
      if (r.rate != null) row.rates.add(r.rate);
      byHsn.set(r.hsn, row);
    }
  }
  const gstTotal = sum('gstTotal');
  const remarks = bills.map((b) => String(b.pricing?.discountRemark || '').trim()).filter(Boolean);
  return {
    lines,
    subtotal: sum('subtotal'),
    discount: sum('discountAmount'),
    discountIsPercent: false,
    discountAmount: sum('discountAmount'),
    discountRemark: [...new Set(remarks)].join('; ').slice(0, 200),
    taxableTotal: sum('taxableTotal'),
    gstTotal,
    taxByHsn: [...byHsn.values()].map((r) => ({ hsn: r.hsn, taxable: r.taxable, gst: r.gst, rate: r.rates.size === 1 ? [...r.rates][0] : null })),
    gstIncluded: false,
    gstRate: bills.reduce((m, b) => Math.max(m, n(b.pricing?.gstRate)), 0),
    total: sum('total'),
    sgst: round2(gstTotal / 2),
    cgst: round2(gstTotal / 2),
    igst: gstTotal,
    invoiceGstMode: withGst ? 'with_gst' : 'without_gst',
    withGst,
    fromBills: true,
  };
}

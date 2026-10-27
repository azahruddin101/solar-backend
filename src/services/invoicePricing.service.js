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

function normalizeLine(l) {
  const qty = Math.max(0, n(l.qty) || 1);
  const rate = round2(l.rate);
  const amount = round2(qty * rate);
  return {
    ...stockFields(l),
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

  const processed = raw.map((l) => {
    const lineGross = round2(l.amount * ratio);
    const catalogPct = l.gstPercent ?? 18;
    const pct = withGst ? catalogPct : 0;
    if (gstIncluded && pct > 0) {
      const taxable = round2(lineGross / (1 + pct / 100));
      const gst = round2(lineGross - taxable);
      return { ...l, gstPercent: catalogPct, amount: lineGross, taxable, gstAmount: gst, lineTotal: lineGross };
    }
    if (!gstIncluded && pct > 0) {
      const taxable = lineGross;
      const gst = round2(taxable * (pct / 100));
      return { ...l, gstPercent: catalogPct, amount: lineGross, taxable, gstAmount: gst, lineTotal: round2(taxable + gst) };
    }
    return { ...l, gstPercent: catalogPct, amount: lineGross, taxable: lineGross, gstAmount: 0, lineTotal: lineGross };
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
  const summary = summarizeLinePricing({
    lines,
    gstIncluded,
    discount: input.discount,
    discountIsPercent: input.discountIsPercent,
    withGst: applyGst,
  });

  if (!(summary.total > 0)) throw badRequest('Invoice total must be greater than zero');

  return {
    lines: summary.lines,
    subtotal: summary.subtotal,
    discountAmount: summary.discountAmount,
    discount: summary.discount,
    discountIsPercent: summary.discountIsPercent,
    discountRemark: String(input.discountRemark || '').slice(0, 200),
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

/** Use custom invoice lines when provided; otherwise recompute from the proposal's saved pricing if it has lines. */
export function resolveInvoicePricing(bodyPricing, designPricing) {
  if (bodyPricing && typeof bodyPricing === 'object') return authorityInvoicePricing(bodyPricing);
  if (designPricing?.lines?.length) return authorityInvoicePricing(designPricing);
  if (designPricing && round2(designPricing.total) > 0) {
    return { ...designPricing, total: round2(designPricing.total) };
  }
  return null;
}

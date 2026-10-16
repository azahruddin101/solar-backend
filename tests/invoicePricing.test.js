import assert from 'node:assert/strict';
import test from 'node:test';
import { authorityInvoicePricing, summarizeLinePricing } from '../src/services/invoicePricing.service.js';

test('summarizeLinePricing uses qty × rate, not client amount', () => {
  const s = summarizeLinePricing({
    lines: [{ name: 'Panel', qty: 2, rate: 1000, gstPercent: 18 }],
    gstIncluded: false,
    withGst: true,
  });
  assert.equal(s.subtotal, 2000);
  assert.equal(s.gstTotal, 360);
  assert.equal(s.total, 2360);
});

test('authorityInvoicePricing ignores a tampered total field', () => {
  const p = authorityInvoicePricing({
    lines: [{ name: 'Service', qty: 1, rate: 5000, gstPercent: 18 }],
    total: 1,
    gstIncluded: false,
    withGst: true,
    invoiceGstMode: 'with_gst',
  });
  assert.equal(p.total, 5900);
  assert.notEqual(p.total, 1);
});

test('authorityInvoicePricing plain invoice without GST', () => {
  const p = authorityInvoicePricing({
    lines: [{ name: 'Labour', qty: 1, rate: 2500 }],
    gstIncluded: false,
    withGst: false,
    invoiceGstMode: 'without_gst',
  });
  assert.equal(p.total, 2500);
  assert.equal(p.gstTotal, 0);
});

test('authorityInvoicePricing applies percent discount before GST', () => {
  const p = authorityInvoicePricing({
    lines: [{ name: 'Item', qty: 1, rate: 10000, gstPercent: 18 }],
    discount: 10,
    discountIsPercent: true,
    gstIncluded: false,
    withGst: true,
  });
  assert.equal(p.discountAmount, 1000);
  assert.equal(p.total, 10620);
});

test('authorityInvoicePricing rejects empty lines', () => {
  assert.throws(() => authorityInvoicePricing({ lines: [] }), /line item/i);
});

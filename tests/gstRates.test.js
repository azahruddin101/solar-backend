// Tax documents show the GST rate actually charged (bug audit group 5): a bill made without GST has its lines at 0 %,
// an invoice made from mixed bills keeps each line at its bill's real rate, and its HSN summary has one row per HSN
// and rate whose GST is that row's taxable × rate. Bills stored before the fix (catalog rate kept on no-GST lines) are
// corrected when an invoice or credit note is built from them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appliedGstPercent, consolidatePricing, summarizeLinePricing } from '../src/services/invoicePricing.service.js';

const cable = { name: 'DC cable', hsn: '8544', qty: 10, rate: 100, gstPercent: 18 };

test('a bill made without GST stores its lines at 0 %', () => {
  const p = summarizeLinePricing({ lines: [cable], gstIncluded: false, withGst: false });
  assert.equal(p.lines[0].gstPercent, 0);
  assert.equal(p.gstTotal, 0);
  assert.deepEqual(p.taxByHsn.map((r) => [r.hsn, r.rate, r.gst]), [['8544', null, 0]]);
  const taxed = summarizeLinePricing({ lines: [cable], gstIncluded: false, withGst: true });
  assert.equal(taxed.lines[0].gstPercent, 18);
  assert.equal(taxed.gstTotal, 180);
});

test('an invoice from a GST bill and a no-GST bill shows each line at its real rate, HSN rows per rate', () => {
  const withGst = { _id: 'b1', billNo: 'BILL-1', pricing: { ...summarizeLinePricing({ lines: [cable], gstIncluded: false, withGst: true }), withGst: true } };
  // stored before the fix: the no-GST bill kept the catalog 18 % on its line, with no GST charged
  const legacy = summarizeLinePricing({ lines: [cable], gstIncluded: false, withGst: false });
  legacy.lines = legacy.lines.map((l) => ({ ...l, gstPercent: 18 }));
  legacy.taxByHsn = [{ hsn: '8544', taxable: 1000, gst: 0, rate: 18 }];
  const noGst = { _id: 'b2', billNo: 'BILL-2', pricing: { ...legacy, withGst: false, invoiceGstMode: 'without_gst' } };

  const inv = consolidatePricing([withGst, noGst]);
  assert.deepEqual(inv.lines.map((l) => [l.billNo, l.gstPercent, l.gstAmount]), [['BILL-1', 18, 180], ['BILL-2', 0, 0]]);
  assert.equal(inv.withGst, true); // still a tax invoice
  assert.equal(inv.gstTotal, 180);
  const rows = inv.taxByHsn.map((r) => [r.hsn, r.rate, r.taxable, r.gst]).sort((a, b) => b[1] - a[1]);
  assert.deepEqual(rows, [['8544', 18, 1000, 180], ['8544', 0, 1000, 0]]);
  for (const r of inv.taxByHsn) assert.equal(r.gst, Math.round(r.taxable * r.rate) / 100); // every row adds up
  assert.equal(inv.total, 2180);
});

test('the rate a stored line was charged', () => {
  assert.equal(appliedGstPercent({ gstPercent: 18, gstAmount: 0 }, false), 0); // no-GST bill
  assert.equal(appliedGstPercent({ gstPercent: 18, gstAmount: 180 }, true), 18);
  assert.equal(appliedGstPercent({ gstPercent: 0, gstAmount: 0 }, true), 0); // an exempt product on a GST bill
});

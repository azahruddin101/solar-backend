// An invoice carries the proposal's discount unchanged and can take an extra discount after it (flat or %).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorityInvoicePricing } from '../src/services/invoicePricing.service.js';

const lines = [{ name: 'Solar system', qty: 1, rate: 100000, amount: 100000, gstPercent: 0 }];

test('proposal discount, then an extra discount on what is left', () => {
  const p = authorityInvoicePricing({ lines, gstIncluded: false, withGst: false, discount: 10, discountIsPercent: true, discountRemark: 'Festive', extraDiscount: 5, extraDiscountIsPercent: true, extraDiscountRemark: 'Prompt payment' });
  assert.equal(p.proposalDiscountAmount, 10000);
  assert.equal(p.extraDiscountAmount, 4500); // 5% of the 90,000 left
  assert.equal(p.discountAmount, 14500);
  assert.equal(p.total, 85500);
  assert.deepEqual([p.discountRemark, p.extraDiscountRemark], ['Festive', 'Prompt payment']);
});

test('a flat extra discount alone, and never more than the subtotal', () => {
  const p = authorityInvoicePricing({ lines, gstIncluded: false, withGst: false, extraDiscount: 2000 });
  assert.deepEqual([p.proposalDiscountAmount, p.extraDiscountAmount, p.total], [0, 2000, 98000]);
  assert.throws(() => authorityInvoicePricing({ lines, gstIncluded: false, withGst: false, discount: 60000, extraDiscount: 90000 }), /greater than zero/);
});

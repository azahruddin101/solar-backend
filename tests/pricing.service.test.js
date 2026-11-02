import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePlanPrice } from '../src/services/pricing.service.js';

test('calculatePlanPrice rejects zero concurrent sign-ins (nothing is unlimited)', () => {
  assert.throws(() => calculatePlanPrice({ maxConcurrentLogins: 0 }), /at least 1/);
});

test('calculatePlanPrice prices on concurrent sign-ins only (clients and proposals are not limited)', () => {
  const p = calculatePlanPrice({ maxClients: 10, maxDesigns: 20, maxConcurrentLogins: 3 });
  assert.deepEqual(p.configuration, { maxConcurrentLogins: 3 });
  assert.equal(p.currency, 'INR');
  assert.equal(p.breakdown.clients, undefined);
  assert.equal(p.breakdown.designs, undefined);
  assert.equal(p.total, p.breakdown.concurrentLogins);
});

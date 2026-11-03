import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePlanPrice } from '../src/services/pricing.service.js';

test('calculatePlanPrice rejects zero concurrent sign-ins (nothing is unlimited)', () => {
  assert.throws(() => calculatePlanPrice({ maxConcurrentLogins: 0 }), /at least 1/);
});

test('calculatePlanPrice prices sign-ins, branches and the company-wide client and design caps', () => {
  const p = calculatePlanPrice({ maxConcurrentLogins: 3, maxBranches: 3, maxClients: 300, maxDesigns: 700 });
  assert.deepEqual(p.configuration, { maxConcurrentLogins: 3, maxBranches: 3, maxClients: 300, maxDesigns: 700 });
  assert.equal(p.currency, 'INR');
  // 3 sign-ins × 1000, 2 extra branches × 1500, 200 extra clients × 10, 500 extra designs × 5
  assert.deepEqual(p.breakdown, { concurrentLogins: 3000, branches: 3000, clients: 2000, designs: 2500 });
  assert.equal(p.total, 10500);
});

test('calculatePlanPrice: the included amounts cost nothing extra, and every cap needs at least 1', () => {
  const p = calculatePlanPrice({ maxConcurrentLogins: 1, maxBranches: 1, maxClients: 100, maxDesigns: 200 });
  assert.deepEqual([p.breakdown.branches, p.breakdown.clients, p.breakdown.designs], [0, 0, 0]);
  assert.throws(() => calculatePlanPrice({ maxConcurrentLogins: 1, maxClients: 0 }), /at least 1/);
});

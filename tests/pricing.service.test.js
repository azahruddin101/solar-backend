import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePlanPrice } from '../src/services/pricing.service.js';

test('calculatePlanPrice rejects zero clients/designs (nothing is unlimited)', () => {
  assert.throws(() => calculatePlanPrice({ maxClients: 0, maxDesigns: 10, maxConcurrentLogins: 2 }), /Clients must be at least 1/);
  assert.throws(() => calculatePlanPrice({ maxClients: 10, maxDesigns: 0, maxConcurrentLogins: 2 }), /Designs must be at least 1/);
  assert.throws(() => calculatePlanPrice({ maxClients: 10, maxDesigns: 10, maxConcurrentLogins: 0 }), /at least 1/);
});

test('calculatePlanPrice returns three-dimension configuration', () => {
  const p = calculatePlanPrice({ maxClients: 10, maxDesigns: 20, maxConcurrentLogins: 3 });
  assert.equal(p.configuration.maxClients, 10);
  assert.equal(p.configuration.maxDesigns, 20);
  assert.equal(p.configuration.maxConcurrentLogins, 3);
  assert.equal(p.currency, 'INR');
  assert.equal(typeof p.breakdown.clients, 'number');
  assert.equal(p.total, p.breakdown.clients + p.breakdown.designs + p.breakdown.concurrentLogins);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { rateLimit, resetRateLimits } from '../src/middlewares/rateLimit.middleware.js';

const run = (limiter, req) => new Promise((resolve) => {
  const headers = {};
  limiter(req, { set: (h) => Object.assign(headers, typeof h === 'string' ? {} : h) }, (err) => resolve({ err, headers }));
});

test('allows up to max per window, then 429 with a wait time', async () => {
  resetRateLimits();
  const limiter = rateLimit({ name: 't1', windowMs: 60000, max: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await run(limiter, { ip: '1.1.1.1' })).err, undefined);
  const blocked = await run(limiter, { ip: '1.1.1.1' });
  assert.equal(blocked.err.status, 429);
  assert.equal(blocked.err.code, 'RATE_LIMITED');
  assert.match(blocked.err.message, /Try again in \d+ seconds/);
});

test('users and addresses are counted separately', async () => {
  resetRateLimits();
  const limiter = rateLimit({ name: 't2', windowMs: 60000, max: 1 });
  assert.equal((await run(limiter, { ip: '1.1.1.1', user: { id: 'a' } })).err, undefined);
  assert.equal((await run(limiter, { ip: '1.1.1.1', user: { id: 'b' } })).err, undefined); // same address, different user
  assert.equal((await run(limiter, { ip: '1.1.1.1', user: { id: 'a' } })).err.status, 429);
  const byIp = rateLimit({ name: 't3', windowMs: 60000, max: 1, by: 'ip' });
  assert.equal((await run(byIp, { ip: '2.2.2.2', user: { id: 'a' } })).err, undefined);
  assert.equal((await run(byIp, { ip: '2.2.2.2', user: { id: 'b' } })).err.status, 429); // users share the address budget
});

test('the window resets', async () => {
  resetRateLimits();
  const limiter = rateLimit({ name: 't4', windowMs: 30, max: 1 });
  assert.equal((await run(limiter, { ip: '3.3.3.3' })).err, undefined);
  assert.equal((await run(limiter, { ip: '3.3.3.3' })).err.status, 429);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal((await run(limiter, { ip: '3.3.3.3' })).err, undefined);
});

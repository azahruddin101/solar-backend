import assert from 'node:assert/strict';
import test from 'node:test';
import { env } from '../src/config/env.js';
import { isOneSignalConfigured, sendPush } from '../src/services/onesignal.service.js';

const realFetch = globalThis.fetch;
const base = { title: 'Installation Step Updated', body: 'Site inspection has been marked as Done.', url: 'http://x/y', data: { status: 'done' }, idempotencyKey: 'k1' };

test.beforeEach(() => { env.oneSignalAppId = 'app-1'; env.oneSignalRestApiKey = 'secret'; });
test.afterEach(() => { globalThis.fetch = realFetch; });

test('is disabled until both credentials are set', () => {
  env.oneSignalRestApiKey = '';
  assert.equal(isOneSignalConfigured(), false);
});

test('posts to the users by external id, with a stable UUID idempotency key', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ id: 'n1' }) }; };
  await sendPush({ ...base, userIds: ['u1', 'u1', 'u2'] });
  await sendPush({ ...base, userIds: ['u1'] });
  assert.equal(calls[0].init.headers.Authorization, 'Key secret');
  assert.deepEqual(calls[0].body.include_aliases.external_id, ['u1', 'u2']);
  assert.equal(calls[0].body.app_id, 'app-1');
  assert.match(calls[0].body.idempotency_key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(calls[0].body.idempotency_key, calls[1].body.idempotency_key);
});

test('sends nothing without recipients', async () => {
  globalThis.fetch = async () => { throw new Error('should not be called'); };
  assert.equal(await sendPush({ ...base, userIds: [] }), null);
});

test('rejects on an API error without leaking the key', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ errors: ['bad'] }) });
  await assert.rejects(sendPush({ ...base, userIds: ['u1'] }), (e) => /OneSignal 400/.test(e.message) && !e.message.includes('secret'));
});

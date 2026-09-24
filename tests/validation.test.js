import assert from 'node:assert/strict';
import test from 'node:test';
import * as S from '../src/validation/schemas.js';

const ok = (schema, value) => { const r = schema.safeParse(value); assert.ok(r.success, JSON.stringify(r.error?.issues)); return r.data; };
const bad = (schema, value, field) => { const r = schema.safeParse(value); assert.ok(!r.success, `expected failure for ${JSON.stringify(value)}`); if (field) assert.ok(r.error.issues.some((i) => i.path.join('.') === field), `no issue on ${field}: ${JSON.stringify(r.error.issues.map((i) => i.path))}`); };
const client = (extra) => ({ name: 'Ravi Kumar', ...extra });

test('email: normalised when valid, rejected when malformed, optional when blank', () => {
  assert.equal(ok(S.clientSchema, client({ email: '  Ravi.K@Example.COM ' })).email, 'ravi.k@example.com');
  for (const e of ['ravi@', 'ravi@example', 'ravi@@example.com', 'ravi example@x.com', 'ravi@exa mple.com', '.ravi@example.com', 'ravi..k@example.com', 'ravi@example.c']) bad(S.clientSchema, client({ email: e }), 'email');
  assert.equal(ok(S.clientSchema, client({ email: '' })).email, '');
  assert.equal(ok(S.clientSchema, client({})).email, undefined);
});

test('phone: exactly 10 digits (prefix and separators dropped); junk rejected; blank allowed', () => {
  for (const p of ['9876543210', '+91 98765 43210', '098765-43210', '(98765) 43210']) assert.equal(ok(S.clientSchema, client({ phone: p })).phone, '9876543210');
  for (const p of ['12345', '5876543210', '98765 4321', 'abcdefghij', '+91 12345 67890', '98765432101', '+14155552671']) bad(S.clientSchema, client({ phone: p }), 'phone');
  ok(S.clientSchema, client({ phone: '' }));
});

test('PAN: uppercased and format-checked', () => {
  assert.equal(ok(S.clientSchema, client({ pan: ' abcpe1234f ' })).pan, 'ABCPE1234F');
  for (const p of ['ABCDE1234', 'ABCDE12345', '1BCPE1234F', 'ABCXE1234F', 'ABC PE1234F']) bad(S.clientSchema, client({ pan: p }), 'pan');
  ok(S.clientSchema, client({ pan: '' }));
});

test('GSTIN (company taxId)', () => {
  assert.equal(ok(S.companySelfSchema, { taxId: '27abcpe1234f1z5' }).taxId, '27ABCPE1234F1Z5');
  for (const g of ['27ABCPE1234F1Z', '99ABCPE1234F1Z5', '27ABCPE1234F1X5', 'hello']) bad(S.companySelfSchema, { taxId: g }, 'taxId');
  ok(S.companySelfSchema, { taxId: '' });
});

test('website, name, numbers', () => {
  for (const w of ['www.example.com', 'https://example.co.in/about', 'example.com']) ok(S.companySelfSchema, { website: w });
  for (const w of ['not a site', 'http://', 'example', 'ftp://x.com']) bad(S.companySelfSchema, { website: w }, 'website');
  bad(S.clientSchema, { name: '' }, 'name');
  bad(S.clientSchema, { name: '12@#' }, 'name');
  bad(S.clientSchema, client({ kwRequired: -3 }), 'kwRequired');
  bad(S.clientSchema, client({ kwRequired: 'abc' }), 'kwRequired');
  assert.equal(ok(S.clientSchema, client({ kwRequired: '' })).kwRequired, null);
  assert.equal(ok(S.clientSchema, client({ kwRequired: '5.5' })).kwRequired, 5.5);
  bad(S.clientSchema, client({ referredBy: { name: 'X', phone: '123' } }), 'referredBy.name');
});

test('passwords: strength only when setting one', () => {
  ok(S.loginSchema, { email: 'a@b.co', password: 'x' });
  bad(S.passwordChangeSchema, { current: 'old', next: 'short1' }, 'next');
  bad(S.passwordChangeSchema, { current: 'old', next: 'onlyletters' }, 'next');
  ok(S.passwordChangeSchema, { current: 'old', next: 'goodpass123' });
  ok(S.agentUpdateSchema, { password: '' }); // blank = keep the current one
  bad(S.agentCreateSchema, { name: 'Asha', email: 'asha@x.com', password: 'weak' }, 'password');
});

test('catalog, package and step numbers', () => {
  const cat = '6ab374ab18ebe1ef7c07dfe9';
  bad(S.productSchema, { category: cat, price: -1 }, 'price');
  bad(S.productSchema, { category: cat, watts: 5000 }, 'watts');
  bad(S.productSchema, { category: cat, hsnCode: '12' }, 'hsnCode');
  ok(S.productSchema, { category: cat, hsnCode: '85414011', price: '1200.50', watts: 540 });
  bad(S.packageSchema, { name: 'P', price: 'abc' }, 'price');
  bad(S.stepUpdateSchema, { status: 'finished' }, 'status');
  bad(S.agentStepStatusSchema, { status: 'done', lat: 200, lng: 10 }, 'lat');
  ok(S.agentStepStatusSchema, { status: 'done', lat: '19.07', lng: '72.87' });
});

test('unknown fields pass through untouched', () => {
  assert.equal(ok(S.clientSchema, client({ documents: [{ url: '/x' }] })).documents.length, 1);
});

test('partial updates stay partial: absent fields are not created or blanked', () => {
  assert.deepEqual(ok(S.stepUpdateSchema, { status: 'done', lat: 1, lng: 2 }), { status: 'done', lat: 1, lng: 2 });
  assert.deepEqual(ok(S.clientUpdateSchema, { phone: '9876543210' }), { phone: '9876543210' });
  assert.deepEqual(ok(S.agentUpdateSchema, { name: 'Asha K' }), { name: 'Asha K' });
  assert.equal(ok(S.clientUpdateSchema, { email: null }).email, ''); // cleared in the form
});

test('required fields say so when missing', () => {
  const r = S.clientSchema.safeParse({});
  assert.equal(r.error.issues.find((i) => i.path[0] === 'name').message, 'Name is required');
  bad(S.stepCreateSchema, {}, 'name');
  bad(S.agentCreateSchema, {}, 'email');
});

test('plan limits must be at least 1 (no unlimited)', () => {
  const plan = { name: 'Team', priceMonthly: 10, maxClients: 20, maxDesigns: 40, maxConcurrentLogins: 2 };
  ok(S.planSchema, plan);
  for (const k of ['maxClients', 'maxDesigns', 'maxConcurrentLogins']) bad(S.planSchema, { ...plan, [k]: 0 }, k);
  bad(S.adminCompanyCreateSchema, { name: 'Acme', loginEmail: 'a@acme.co', password: 'Goodpass123', limits: { maxClients: 0 } }, 'limits.maxClients');
  bad(S.planRequestSchema, { type: 'custom', message: 'x', requestedLimits: { maxDesigns: 0 } }, 'requestedLimits.maxDesigns');
  bad(S.planRequestApproveSchema, { maxClients: 0 }, 'maxClients');
});

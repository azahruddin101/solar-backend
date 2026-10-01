import assert from 'node:assert/strict';
import test from 'node:test';
import { formatInvoiceNo } from '../src/services/invoiceNumber.service.js';
import * as S from '../src/validation/schemas.js';

const ok = (schema, value) => { const r = schema.safeParse(value); assert.ok(r.success, JSON.stringify(r.error?.issues)); return r.data; };
const bad = (schema, value, field) => { const r = schema.safeParse(value); assert.ok(!r.success, `expected failure for ${JSON.stringify(value)}`); if (field) assert.ok(r.error.issues.some((i) => i.path.join('.') === field), `no issue on ${field}: ${JSON.stringify(r.error.issues.map((i) => i.path))}`); };

test('invoice numbers: fixed part + running number padded to the chosen width; never wraps or truncates', () => {
  const n = { prefix: 'INVCMP2026', width: 4 };
  assert.equal(formatInvoiceNo(n, 1), 'INVCMP20260001');
  assert.equal(formatInvoiceNo(n, 11), 'INVCMP20260011');
  assert.equal(formatInvoiceNo(n, 9999), 'INVCMP20269999');
  assert.equal(formatInvoiceNo(n, 10000), 'INVCMP202610000');
  assert.equal(formatInvoiceNo({ prefix: '', width: 1 }, 7), '7');
  assert.equal(formatInvoiceNo({ prefix: 'INV/26-27/', width: 3 }, 42), 'INV/26-27/042');
  assert.equal(formatInvoiceNo(undefined, 3), 'INV-0003', 'legacy default is INV-0001 style');
});

test('invoice numbering settings: prefix characters, digits-only next number, leading zeros kept', () => {
  const data = ok(S.companySelfSchema, { invoiceNumbering: { prefix: ' INVCMP2026 ', next: '0001' } });
  assert.deepEqual(data.invoiceNumbering, { prefix: 'INVCMP2026', next: '0001' });
  ok(S.companySelfSchema, { invoiceNumbering: { prefix: '', next: '1' } });
  ok(S.companySelfSchema, { invoiceNumbering: { prefix: 'INV/26-27/_.', next: '0000000001' } });
  for (const prefix of ['INV 2026', 'INV#', 'INV@', 'A'.repeat(21)]) bad(S.companySelfSchema, { invoiceNumbering: { prefix, next: '0001' } }, 'invoiceNumbering.prefix');
  for (const next of ['', '0', '0000', 'abc', '12a', '1.5', '-1', '00000000001']) bad(S.companySelfSchema, { invoiceNumbering: { prefix: 'INV', next } }, 'invoiceNumbering.next');
  assert.equal(ok(S.companySelfSchema, { name: 'Acme' }).invoiceNumbering, undefined, 'other settings saves leave numbering alone');
});

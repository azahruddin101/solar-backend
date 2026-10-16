import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { parseLeadForm, formOf, cleanLeadValues, FIXED_KEYS } = require('../leads-integration/utils/leadForm.js');

test('a company form always starts with Name, Phone and Address', () => {
  const form = formOf({ leadForm: [{ key: 'bill', label: 'Monthly bill', type: 'number', required: true, options: [] }] });
  assert.deepEqual(form.slice(0, 3).map((f) => f.key), FIXED_KEYS);
  assert.equal(form[3].key, 'bill');
});

test('parsing a form: keys from labels, kept on edit, no clashes with the fixed fields', () => {
  const first = parseLeadForm([{ label: 'Monthly bill (₹)', type: 'number' }, { label: 'Roof type', type: 'select', options: ['RCC', 'Tin shed', 'RCC'] }]);
  assert.deepEqual(first.map((f) => f.key), ['monthly_bill', 'roof_type']);
  assert.deepEqual(first[1].options, ['RCC', 'Tin shed']);
  const renamed = parseLeadForm([{ key: 'monthly_bill', label: 'Average electricity bill', type: 'number' }], first);
  assert.equal(renamed[0].key, 'monthly_bill'); // existing answers stay linked
  assert.equal(parseLeadForm([{ label: 'Phone 2', type: 'phone' }])[0].key, 'phone_2');
  assert.throws(() => parseLeadForm([{ label: 'phone', type: 'text' }]), /already a field/);
  assert.throws(() => parseLeadForm([{ label: 'Roof', type: 'select', options: [] }]), /at least one choice/);
  assert.throws(() => parseLeadForm([{ label: 'X', type: 'colour' }]), /Choose a type/);
});

test('values are checked against the form', () => {
  const form = formOf({ leadForm: parseLeadForm([
    { label: 'Monthly bill', type: 'number', required: true },
    { label: 'Roof type', type: 'select', options: ['RCC', 'Tin shed'] },
    { label: 'Needs', type: 'multiselect', options: ['Subsidy', 'Loan'] },
    { label: 'Visit on', type: 'date' },
    { label: 'Owns house', type: 'yesno' },
    { label: 'Email', type: 'email' },
  ]) });
  const ok = cleanLeadValues(form, { name: '  Asha  Patil ', phone: '+91 98765 43210', monthly_bill: '2,500', roof_type: 'rcc', needs: 'loan, Subsidy', visit_on: '16/10/2026', owns_house: 'Yes', email: 'A@B.com' });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.name, 'Asha Patil');
  assert.deepEqual(ok.values.fields, { monthly_bill: 2500, roof_type: 'RCC', needs: ['Loan', 'Subsidy'], visit_on: '2026-10-16', owns_house: true, email: 'a@b.com' });
  const bad = cleanLeadValues(form, { name: '', phone: 'abc', monthly_bill: 'lots', roof_type: 'Mud', visit_on: '31/02/2026', owns_house: 'maybe', email: 'nope' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['email', 'monthly_bill', 'name', 'owns_house', 'phone', 'roof_type', 'visit_on']);
});

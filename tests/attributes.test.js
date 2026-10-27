import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeKey, cleanAttributeDefs, validateAttributes } from '../src/services/attribute.service.js';

const defs = cleanAttributeDefs([
  { label: 'Efficiency (%)', dataType: 'number', isRequired: true },
  { label: 'Cell type', dataType: 'select', options: ['Mono PERC', 'N-type TOPCon'] },
  { label: 'Bifacial', dataType: 'boolean' },
  { label: 'Notes' },
]);

test('attribute keys come from the labels', () => {
  assert.equal(attributeKey('Efficiency (%)'), 'efficiency');
  assert.equal(attributeKey('MPPT count'), 'mpptCount');
  assert.deepEqual(defs.map((d) => d.key), ['efficiency', 'cellType', 'bifacial', 'notes']);
});

test('values are typed: numbers, select options (any case), booleans', () => {
  const out = validateAttributes(defs, { efficiency: '21.5', cellType: 'n-type topcon', bifacial: 'yes', notes: ' ok ' });
  assert.deepEqual(out, { efficiency: 21.5, cellType: 'N-type TOPCon', bifacial: true, notes: 'ok' });
});

test('required, number and select rules are enforced on the server', () => {
  assert.throws(() => validateAttributes(defs, {}), /Efficiency \(%\) is required/);
  assert.throws(() => validateAttributes(defs, { efficiency: 'high' }), /must be a number/);
  assert.throws(() => validateAttributes(defs, { efficiency: 20, cellType: 'Thin film' }), /must be one of/);
});

test('values for attributes the category no longer defines are kept on edit; unknown new keys are dropped', () => {
  const out = validateAttributes(defs, { efficiency: 20, sneaky: 'x' }, { oldWattClass: 'A', efficiency: 19 });
  assert.deepEqual(out, { oldWattClass: 'A', efficiency: 20 });
});

test('a select needs options and keys must be unique', () => {
  assert.throws(() => cleanAttributeDefs([{ label: 'Phase', dataType: 'select' }]), /at least one option/);
  assert.throws(() => cleanAttributeDefs([{ label: 'Phase' }, { label: 'phase' }]), /listed twice/);
});

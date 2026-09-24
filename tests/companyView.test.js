import assert from 'node:assert/strict';
import test from 'node:test';
import { Company } from '../src/models/index.js';
import { ADMIN_ONLY, OWNER_VISIBLE, ownerCompanyView } from '../src/utils/companyView.js';

const SYSTEM = ['_id', '__v'];
const topLevel = [...new Set(Object.keys(Company.schema.paths).map((p) => p.split('.')[0]))];

test('every Company field is classified as owner-visible or admin-only (a new field must be decided on)', () => {
  const unclassified = topLevel.filter((f) => !OWNER_VISIBLE.includes(f) && !ADMIN_ONLY.includes(f) && !SYSTEM.includes(f));
  assert.deepEqual(unclassified, [], `Classify these Company fields in utils/companyView.js: ${unclassified.join(', ')}`);
});

test('admin-only fields never reach the owner', async () => {
  const company = new Company({ name: 'Acme', email: 'a@acme.co', notes: 'PRIVATE: payment overdue', plan: 'growth' });
  const view = await ownerCompanyView(company);
  for (const f of ADMIN_ONLY) assert.equal(f in view, false, `${f} leaked`);
  assert.ok(!JSON.stringify(view).includes('PRIVATE'));
  assert.equal(view.name, 'Acme');
  assert.ok(view.billing, 'billing summary is still included');
});

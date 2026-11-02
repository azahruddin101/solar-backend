import assert from 'node:assert/strict';
import test from 'node:test';
import { ROLES } from '../src/constants/index.js';
import { hasBranchOwnerAccess, isOrgAdmin, isBranchOwner } from '../src/constants/tenant.js';

test('tenant role helpers', () => {
  assert.equal(isOrgAdmin({ role: ROLES.COMPANY }), true);
  assert.equal(isBranchOwner({ role: ROLES.BRANCH }), true);
  assert.equal(hasBranchOwnerAccess({ role: ROLES.BRANCH }), true);
  assert.equal(hasBranchOwnerAccess({ role: ROLES.COMPANY }), true);
  assert.equal(hasBranchOwnerAccess({ role: ROLES.AGENT }), false);
});

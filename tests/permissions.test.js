import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEGACY_PERMISSION_MAP,
  PERMISSION_CATALOG,
  ROLE_TEMPLATES,
  STAFF_PERMISSIONS,
  migrateLegacyPermissions,
  upgradePermissions,
  normalizePermissions,
} from '../src/constants/permissions.js';
import { hasAreaAccess, hasPermission } from '../src/middlewares/auth.middleware.js';
import * as frontend from '../../frontend/src/lib/permissions.js';
import { AREA_STYLE, PLAIN } from '../../frontend/src/lib/permissionStyles.js';

test('the frontend mirrors the permission catalog exactly', () => {
  assert.deepEqual(frontend.PERMISSION_CATALOG, PERMISSION_CATALOG);
});

test('the staff and role screens have a style and plain-words text for every area and action', () => {
  for (const [area, a] of Object.entries(PERMISSION_CATALOG)) {
    assert.ok(AREA_STYLE[area]?.icon && AREA_STYLE[area].bar && AREA_STYLE[area].soft, `no style for the ${area} area`);
    for (const action of Object.keys(a.actions)) assert.ok(PLAIN[area]?.[action], `no plain-words text for ${area}:${action}`);
  }
});

test('every area has view, and every permission string is area:action', () => {
  for (const [area, a] of Object.entries(PERMISSION_CATALOG)) {
    assert.ok(a.actions.view, `${area} has no view`);
    assert.ok(a.label && a.description, `${area} needs a label and description`);
  }
  assert.ok(STAFF_PERMISSIONS.every((p) => /^[a-z]+:[a-z_]+$/.test(p)));
  assert.equal(new Set(STAFF_PERMISSIONS).size, STAFF_PERMISSIONS.length);
});

test('normalizing drops unknown permissions and brings view along', () => {
  assert.deepEqual(normalizePermissions(['finances:create_receipt', 'nope:x', 'finances:create_receipt', 42]), ['finances:create_receipt', 'finances:view']);
  assert.deepEqual(frontend.normalizePermissions(['finances:create_receipt', 'nope:x']), ['finances:create_receipt', 'finances:view']);
  assert.deepEqual(normalizePermissions(undefined), []);
});

test('migrating old grants keeps exactly the same access and never adds view', () => {
  for (const [old, now] of Object.entries(LEGACY_PERMISSION_MAP)) {
    assert.ok(now.every((p) => STAFF_PERMISSIONS.includes(p)), `${old} maps to an unknown permission`);
  }
  assert.deepEqual(migrateLegacyPermissions(['billing:create']), ['finances:create_invoice', 'finances:create_receipt']);
  assert.deepEqual(migrateLegacyPermissions(['designs:update', 'clients:update']), ['clients:manage_login', 'clients:update', 'proposals:change_client', 'proposals:change_status', 'proposals:share', 'proposals:update']);
  assert.deepEqual(migrateLegacyPermissions(['catalog:delete', 'installations:view', 'billing:update', 'garbage']), ['inventory:delete', 'tasks:view']);
  assert.deepEqual(migrateLegacyPermissions(['finances:view', 'designs:view']), ['finances:view', 'proposals:view']); // new-only names are kept
});

test('role templates only use real permissions', () => {
  for (const t of ROLE_TEMPLATES) {
    assert.ok(t.permissions.every((p) => STAFF_PERMISSIONS.includes(p)), `${t.key} uses an unknown permission`);
  }
  const cashier = ROLE_TEMPLATES.find((t) => t.key === 'cashier');
  assert.ok(cashier.permissions.includes('finances:create_receipt') && !cashier.permissions.includes('finances:create_invoice'));
});

test('hasPermission: owner has everything, staff only their effective permissions, others nothing', () => {
  const owner = { role: 'company' };
  const staff = { role: 'agent', permissions: ['finances:view'], effectivePermissions: ['finances:view', 'finances:create_receipt'] };
  const client = { role: 'client', permissions: ['finances:view'] };
  assert.equal(hasPermission(owner, 'finances', 'remove_receipt'), true);
  assert.equal(hasPermission(staff, 'finances', 'create_receipt'), true); // from a role
  assert.equal(hasPermission(staff, 'finances', 'create_invoice'), false);
  assert.equal(hasPermission(client, 'finances', 'view'), false);
  assert.equal(hasAreaAccess(staff, 'finances'), true);
  assert.equal(hasAreaAccess(staff, 'tasks'), false);
  assert.equal(frontend.can({ role: 'agent', permissions: ['tasks:view'] }, 'tasks', 'view'), true);
  assert.equal(frontend.can({ role: 'client', permissions: ['tasks:view'] }, 'tasks', 'view'), false);
});

test('upgrading from version 2: Edit keeps covering what it covered before the split', () => {
  assert.deepEqual(upgradePermissions(['proposals:update', 'tasks:update', 'clients:view'], 2), ['clients:view', 'proposals:change_client', 'proposals:change_status', 'proposals:update', 'tasks:assign', 'tasks:change_status', 'tasks:update']);
  assert.deepEqual(upgradePermissions(['proposals:view', 'finances:create_receipt'], 2), ['finances:create_receipt', 'proposals:view']); // nothing to split
  assert.deepEqual(upgradePermissions(['installations:update'], 1), ['tasks:assign', 'tasks:change_status', 'tasks:update']); // oldest names all the way
  assert.deepEqual(upgradePermissions(['tasks:update'], 3), ['tasks:update']); // already current: untouched
});

test('leads: View all brings the own-leads View along; Telecaller can change status but not assign or export', () => {
  assert.deepEqual(normalizePermissions(['leads:view_all']), ['leads:view', 'leads:view_all']);
  const telecaller = ROLE_TEMPLATES.find((t) => t.key === 'telecaller').permissions;
  assert.ok(telecaller.includes('leads:change_status'));
  assert.ok(!telecaller.some((p) => ['leads:assign', 'leads:export', 'leads:view_all'].includes(p)));
});

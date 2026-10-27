// Who may use the Loans, Suppliers and AMC routes: each route's real gates (the area check and its permission or role
// gate) are replayed for the owner, staff with different permissions, and a client. Staff permissions come from their
// roles at the time of the request, so editing a role changes access straight away (the last test).
import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { allRoutes } from './helpers/routes.js';
import { normalizePermissions } from '../src/constants/permissions.js';
import { effectiveFrom } from '../src/services/permission.service.js';

const company = new mongoose.Types.ObjectId();
const owner = { role: 'company', company };
const client = { role: 'client', company };
/** A staff member as authenticate() leaves them: effective permissions resolved, each action bringing its `view`. */
const staff = (...permissions) => ({ role: 'agent', company, effectivePermissions: normalizePermissions(permissions) });

/** True when every gate in front of the route lets this user through. */
function allowed(user, method, path) {
  const route = allRoutes.find((r) => r.method === method && r.path === path);
  assert.ok(route, `${method} ${path} not found`);
  const gates = route.chain.filter((fn) => fn.authorizes || fn.areaCheck);
  assert.ok(gates.length, `${method} ${path} has no gate`);
  try {
    for (const gate of gates) gate({ user }, {}, () => {});
    return true;
  } catch (e) {
    if (e.status === 403 || e.statusCode === 403) return false;
    throw e;
  }
}

/** [method, path, who may, who may not] for each row. */
function check(rows) {
  for (const [method, path, yes, no] of rows) {
    for (const [name, user] of Object.entries(yes)) assert.equal(allowed(user, method, path), true, `${name} should reach ${method} ${path}`);
    for (const [name, user] of Object.entries(no)) assert.equal(allowed(user, method, path), false, `${name} should not reach ${method} ${path}`);
  }
}

test('loans: viewing needs Loans › View, every change Loans › Update, the loan step template is the owner’s', () => {
  const viewer = staff('loans:view');
  const editor = staff('loans:update');
  const outsider = staff('proposals:update', 'clients:view');
  const reads = { owner, viewer, editor };
  const writes = { owner, editor };
  check([
    ['GET', '/api/loans', reads, { outsider, client }],
    ['GET', '/api/loans/:id', reads, { outsider, client }],
    ['GET', '/api/loans/proposal/:designId', reads, { outsider, client }],
    ['GET', '/api/loans/steps', reads, { outsider, client }],
    ['PUT', '/api/loans/:id', writes, { viewer, outsider, client }],
    ['PUT', '/api/loans/:id/steps/:stepId', writes, { viewer, outsider, client }],
    ['POST', '/api/loans/:id/steps/:stepId/documents', writes, { viewer, outsider, client }],
    ['PUT', '/api/loans/:id/steps/:stepId/documents/:docId', writes, { viewer, outsider, client }],
    ['DELETE', '/api/loans/:id/steps/:stepId/documents/:docId', writes, { viewer, outsider, client }],
    ['POST', '/api/loans/:id/sync-steps', writes, { viewer, outsider, client }],
    ['PUT', '/api/loans/steps', { owner }, { editor, client }],
    ['GET', '/api/portal/loans', { client }, { owner, editor }],
  ]);
});

test('suppliers: listed for inventory, finances and installations; purchases for inventory and finances; changes need Inventory', () => {
  const store = staff('inventory:view');
  const accounts = staff('finances:view');
  const field = staff('tasks:view');
  const outsider = staff('loans:update', 'proposals:view');
  check([
    ['GET', '/api/suppliers', { owner, store, accounts, field }, { outsider, client }],
    ['GET', '/api/suppliers/:id/purchases', { owner, store, accounts }, { field, outsider, client }],
    ['POST', '/api/suppliers', { owner, creator: staff('inventory:create') }, { store, accounts, field, editor: staff('inventory:update') }],
    ['PUT', '/api/suppliers/:id', { owner, editor: staff('inventory:update') }, { store, accounts, creator: staff('inventory:create') }],
    ['DELETE', '/api/suppliers/:id', { owner, remover: staff('inventory:delete') }, { store, editor: staff('inventory:update') }],
  ]);
});

test('AMC: all visits need Installations › View; assigning, completing and invoicing parts are their own permissions', () => {
  const viewer = staff('tasks:view');
  const assigner = staff('tasks:assign');
  const completer = staff('tasks:change_status');
  const invoicer = staff('tasks:invoice_parts');
  const editor = staff('tasks:update');
  const outsider = staff('proposals:view', 'loans:update');
  check([
    ['GET', '/api/projects/amc-visits', { owner, viewer, assigner }, { outsider, client }],
    ['GET', '/api/projects/amc-overview', { owner, viewer }, { outsider, client }],
    ['GET', '/api/projects/amc-requests', { owner, viewer }, { outsider, client }],
    ['GET', '/api/projects/amc-templates', { owner, viewer }, { outsider, client }],
    ['PUT', '/api/projects/amc-templates', { owner }, { assigner, editor, client }],
    ['POST', '/api/projects/:id/amc', { owner, assigner }, { viewer, editor, completer }],
    ['PUT', '/api/projects/:id/amc/:visitId/assign', { owner, assigner }, { viewer, editor, completer }],
    ['PUT', '/api/projects/amc-requests/:designId/:requestId/assign', { owner, assigner }, { viewer, editor }],
    ['PUT', '/api/projects/:id/amc/:visitId', { owner, completer }, { viewer, editor, assigner }],
    ['POST', '/api/projects/:id/amc/:visitId/invoice', { owner, invoicer }, { viewer, editor, assigner, completer }],
    ['GET', '/api/projects/:id/amc/:visitId/invoice', { owner, invoicer }, { viewer, assigner }],
    // a staff member's own visits: any staff account (the service only returns visits assigned to them)
    ['GET', '/api/my/projects/amc-visits', { outsider, viewer }, { owner, client }],
    ['PUT', '/api/my/projects/:id/amc/:visitId', { outsider }, { owner, client }],
    ['POST', '/api/my/projects/:id/amc/:visitId/invoice', { invoicer }, { outsider, viewer, owner }],
    ['POST', '/api/portal/proposals/:id/amc-requests', { client }, { owner, assigner }],
  ]);
});

test('access follows the staff member’s roles as they are now: editing a role takes effect on the next request', () => {
  const role = { _id: new mongoose.Types.ObjectId(), permissions: ['loans:view', 'loans:update', 'inventory:view'] };
  const person = { role: 'agent', company, staffRoles: [role._id], permissions: ['tasks:assign', 'tasks:view'] };
  const asNow = () => ({ ...person, effectivePermissions: effectiveFrom(person, new Map([[String(role._id), role]])) });

  assert.equal(allowed(asNow(), 'PUT', '/api/loans/:id'), true);
  assert.equal(allowed(asNow(), 'GET', '/api/suppliers/:id/purchases'), true);
  assert.equal(allowed(asNow(), 'POST', '/api/projects/:id/amc'), true); // their own extra grant

  role.permissions = ['loans:view']; // the owner narrows the role
  assert.equal(allowed(asNow(), 'PUT', '/api/loans/:id'), false);
  assert.equal(allowed(asNow(), 'GET', '/api/loans/:id'), true);
  assert.equal(allowed(asNow(), 'GET', '/api/suppliers/:id/purchases'), false);

  person.staffRoles = []; // the role is taken off them
  assert.equal(allowed(asNow(), 'GET', '/api/loans'), false);
  assert.equal(allowed(asNow(), 'POST', '/api/projects/:id/amc'), true);
});

// Every API route must be gated by a role or a permission (auth.middleware.js marks those gates), unless it is on
// the short list below of routes that are public by design or let the service decide per record. A new route that
// forgets its gate fails this test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { allRoutes } from './helpers/routes.js';

const all = allRoutes;
const gated = (r) => r.chain.some((fn) => fn.authorizes);
const signedIn = (r) => r.chain.some((fn) => fn.name === 'authenticate' || fn.name === 'authenticateMapAccess');

// public by design (each authenticates itself: token, signature, state, key, or nothing to protect)
const PUBLIC = [
  /^\/health$/,
  /^\/uploads(\/|$)/,
  /^\/api\/auth\/login$/,
  /^\/api\/public\//,
  /^\/api\/webhooks\/meta$/,
  /^\/api\/company\/integrations\/meta\/callback$/,
  /^\/api\/company\/google-leads\/webhook$/,
  /^\/api\/staticmap(\/|$)/,
];
// any signed-in user; the service decides per record (own account, own inbox, own tickets, files they may open)
const SELF_SERVICE = [/^\/api\/auth\//, /^\/api\/notifications(\/|$)/, /^\/api\/files(\/|$)/, /^\/api\/tickets(\/|$)/, /^\/api\/staticmap(\/|$)/];

test('the route walk finds the API', () => {
  assert.ok(all.length > 100, `only ${all.length} routes found`);
  assert.ok(all.some((r) => r.path === '/api/billing/invoices/from-bills'));
});

test('every API route is gated by a role or a permission', () => {
  const open = all.filter((r) => !gated(r) && !PUBLIC.some((re) => re.test(r.path)) && !(signedIn(r) && SELF_SERVICE.some((re) => re.test(r.path))));
  assert.deepEqual(open.map((r) => `${r.method} ${r.path}`), []);
});

test('nothing outside the public list is reachable without signing in', () => {
  const anonymous = all.filter((r) => !signedIn(r) && !PUBLIC.some((re) => re.test(r.path)));
  assert.deepEqual(anonymous.map((r) => `${r.method} ${r.path}`), []);
});

test('finance actions are separate permissions', () => {
  const gate = (method, path) => all.find((r) => r.method === method && r.path === path)?.chain.map((fn) => fn.authorizes).filter(Boolean);
  // invoices come only from bills: there is no invoice straight from a proposal and no direct invoice
  assert.equal(all.some((r) => r.path === '/api/billing/designs/:id/invoice'), false);
  assert.equal(all.some((r) => r.method === 'POST' && r.path === '/api/billing/invoices'), false);
  // the sale chain: each document has its own permission, reading them is Finances › View
  // voiding takes a payment off the books and reopens goods: the company owner only, not a staff permission
  assert.ok(gate('POST', '/api/billing/bills/:id/void').some((g) => /role/.test(g) && /company/.test(g)));
  assert.ok(gate('POST', '/api/billing/bills/:id/credit-notes').some((g) => /role/.test(g) && /company/.test(g))); // goods back on a bill: the owner too
  assert.ok(gate('POST', '/api/billing/invoices/:id/void').some((g) => /role/.test(g) && /company/.test(g)));
  assert.ok(gate('POST', '/api/billing/eway-bills').includes('permission:finances:create_eway_bill'));
  assert.ok(gate('POST', '/api/billing/eway-bills/:id/cancel').includes('permission:finances:create_eway_bill'));
  assert.ok(gate('POST', '/api/billing/bills').includes('permission:finances:create_bill'));
  assert.ok(gate('POST', '/api/billing/invoices/from-bills').includes('permission:finances:create_invoice'));
  assert.ok(gate('GET', '/api/billing/bills/uninvoiced').includes('permission:finances:view'));
});

test('masters, staff and roles are owner-only', () => {
  for (const [method, path] of [['PUT', '/api/projects/steps'], ['PUT', '/api/company/catalog-settings'], ['PUT', '/api/company'], ['POST', '/api/agents'], ['PUT', '/api/agents/:id'], ['POST', '/api/roles'], ['PUT', '/api/roles/:id'], ['DELETE', '/api/roles/:id']]) {
    const r = all.find((x) => x.method === method && x.path === path);
    assert.ok(r, `${method} ${path} not found`);
    assert.ok(r.chain.some((fn) => fn.authorizes === 'role:company'), `${method} ${path} is not owner-only`);
  }
});

test('leads: each action has its own permission, and the old owner-only copies are gone', () => {
  const gate = (method, path) => all.find((r) => r.method === method && r.path === path)?.chain.map((fn) => fn.authorizes).filter(Boolean) || [];
  assert.ok(gate('GET', '/api/leads/meta').includes('permission:leads:view|view_all'));
  assert.ok(gate('PUT', '/api/leads/meta/:id/status').includes('permission:leads:change_status'));
  assert.ok(gate('POST', '/api/leads/meta/assign').includes('permission:leads:assign'));
  assert.ok(gate('PUT', '/api/leads/google/:id/priority').includes('permission:leads:update'));
  assert.ok(gate('GET', '/api/leads/export').includes('permission:leads:export'));
  assert.ok(gate('GET', '/api/leads/reports/telecallers').includes('role:company'));
  for (const [method, path] of [['GET', '/api/company/integrations/meta/leads'], ['POST', '/api/company/integrations/meta/leads/assign'], ['GET', '/api/company/google-leads'], ['GET', '/api/company/integrations/meta/my-leads']]) {
    assert.ok(!all.some((r) => r.method === method && r.path === path), `${method} ${path} should no longer exist`);
  }
});

test('installations: assigning steps and updating their status are their own permissions', () => {
  const gate = (method, path) => all.find((r) => r.method === method && r.path === path)?.chain.map((fn) => fn.authorizes).filter(Boolean) || [];
  assert.ok(gate('POST', '/api/projects/:id/steps/:stepId/photo').includes('permission:tasks:change_status'));
  assert.ok(gate('GET', '/api/projects/assignees').includes('permission:tasks:assign'));
  assert.ok(gate('POST', '/api/designs/:id/send-for-review').includes('permission:proposals:change_status'));
});

test('manual leads: adding and importing need Leads › Add & import; the lead form is a master', () => {
  const gate = (method, path) => all.find((r) => r.method === method && r.path === path)?.chain.map((fn) => fn.authorizes).filter(Boolean) || [];
  assert.ok(gate('POST', '/api/leads/manual').includes('permission:leads:create'));
  assert.ok(gate('POST', '/api/leads/manual/import').includes('permission:leads:create'));
  assert.ok(gate('PUT', '/api/leads/manual/:id').includes('permission:leads:update'));
  assert.ok(gate('PUT', '/api/leads/manual/:id/status').includes('permission:leads:change_status'));
  assert.ok(gate('GET', '/api/leads/manual').includes('permission:leads:view|view_all'));
  assert.ok(gate('PUT', '/api/company/lead-form').includes('role:company'));
});

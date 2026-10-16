// Every API route must be gated by a role or a permission (auth.middleware.js marks those gates), unless it is on
// the short list below of routes that are public by design or let the service decide per record. A new route that
// forgets its gate fails this test.
import assert from 'node:assert/strict';
import test from 'node:test';
import Router from 'router';

// Express 5 doesn't keep the path a layer was mounted at; remember it so the walk below can print real paths.
const originalUse = Router.prototype.use;
Router.prototype.use = function use(...args) {
  const before = this.stack.length;
  const result = originalUse.apply(this, args);
  const path = typeof args[0] === 'string' ? args[0] : '/';
  for (let i = before; i < this.stack.length; i += 1) this.stack[i].mountPath = path;
  return result;
};
process.env.NODE_ENV = 'test';
const { default: app } = await import('../src/app.js');

const join = (a, b) => `${a}/${b}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
const applies = (mountPath, path) => mountPath === '/' || path === mountPath || path.startsWith(`${mountPath}/`);

/** Every route as { method, path, handlers } with the middleware that runs before it. */
function routes(stack, prefix = '', inherited = []) {
  const out = [];
  const before = [];
  for (const layer of stack) {
    const local = layer.mountPath ?? '/';
    if (layer.route) {
      const path = join(prefix, layer.route.path);
      const chain = [...inherited, ...before.filter((b) => applies(b.at, path)).map((b) => b.fn), ...layer.route.stack.map((l) => l.handle)];
      for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path, chain });
    } else if (layer.handle?.stack) {
      const path = join(prefix, local);
      out.push(...routes(layer.handle.stack, path, [...inherited, ...before.filter((b) => applies(b.at, path)).map((b) => b.fn)]));
    } else {
      before.push({ at: join(prefix, local), fn: layer.handle });
    }
  }
  return out;
}

const all = routes(app.router.stack);
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
  assert.ok(all.some((r) => r.path === '/api/billing/designs/:id/payments'));
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
  assert.ok(gate('POST', '/api/billing/designs/:id/payments').includes('permission:finances:create_receipt'));
  assert.ok(gate('POST', '/api/billing/designs/:id/invoice').includes('permission:finances:create_invoice'));
  assert.ok(gate('POST', '/api/billing/invoices').includes('permission:finances:create_invoice'));
  assert.ok(gate('DELETE', '/api/billing/payments/:id').includes('permission:finances:remove_receipt'));
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

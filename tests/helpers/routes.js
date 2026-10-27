// Every API route of the app with the middleware chain that runs before its handler, for the access tests.
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
const { default: app } = await import('../../src/app.js');

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

export const allRoutes = routes(app.router.stack);

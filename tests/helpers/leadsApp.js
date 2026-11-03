// The real leads router (src/routes/leads.routes.js) on a throwaway HTTP server, signed in as whoever a test chooses.
// Use with mongodb-memory-server only.
import { createRequire } from 'node:module';
import express from 'express';
import { Company, User } from '../../src/models/index.js';

const require = createRequire(import.meta.url);
export const ManualLead = require('../../leads-integration/models/ManualLead.js');
export const GoogleLead = require('../../leads-integration/models/GoogleLead.js');
export const MetaLead = require('../../leads-integration/models/MetaLead.js');
export const MetaLeadStatus = require('../../leads-integration/models/MetaLeadStatus.js');
export const MetaLeadAssignment = require('../../leads-integration/models/MetaLeadAssignment.js');

/** Starts the app; returns { call, as, stop }. `as(user, company)` signs in the next calls as that user. */
export async function startLeadsApp() {
  const { default: router } = await import('../../src/routes/leads.routes.js');
  const { metaRoutes, sheetRoutes, googleLeadRoutes } = await import('../../src/integrations/leads.js');
  let current = null;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = current.user;
    req.company = current.company;
    next();
  });
  app.use('/api/leads', router);
  // the owner-only lead integrations (statuses, Meta, Sheet, Google Ads), as src/routes/company.routes.js mounts them
  app.use('/api/company/integrations/meta', metaRoutes);
  app.use('/api/company/integrations/sheet', sheetRoutes);
  app.use('/api/company/google-leads', googleLeadRoutes);
  app.use((err, req, res, next) => res.status(err.status || err.statusCode || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const as = async (user, company) => {
    const u = await User.findById(user._id);
    u.effectivePermissions = [...(u.permissions || [])];
    current = { user: u, company: await Company.findById(company._id).lean() };
  };
  return { call, as, stop: () => new Promise((resolve) => server.close(resolve)) };
}

let n = 0;
export const mkUser = (company, extra) => User.create({ email: `u${++n}@x.test`, passwordHash: 'x', name: `User${n}`, company: company._id, active: true, ...extra });

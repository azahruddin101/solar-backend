import { Company, Plan } from '../models/index.js';
import { applyPlanLimitsToCompany } from '../services/plan.service.js';

const DEFAULTS = [
  { code: 'basic', name: 'Basic', description: 'For small teams getting started.', kind: 'fixed', priceMonthly: 30, maxConcurrentLogins: 2, maxBranches: 1, maxClients: 100, maxDesigns: 200, selfServe: true, sortOrder: 1 },
  { code: 'pro', name: 'Pro', description: 'More devices signed in at once.', kind: 'fixed', priceMonthly: 60, maxConcurrentLogins: 5, maxBranches: 3, maxClients: 500, maxDesigns: 1000, selfServe: true, sortOrder: 2 },
  { code: 'custom', name: 'Custom', description: 'Limits and pricing set by the platform admin (Hotstar-style).', kind: 'custom', priceMonthly: 0, maxConcurrentLogins: 5, maxBranches: 5, maxClients: 1000, maxDesigns: 2000, selfServe: false, sortOrder: 3 },
];

const LEGACY_MAP = { starter: 'basic', growth: 'pro', enterprise: 'custom' };

export async function ensureDefaultPlans() {
  for (const { maxBranches, maxClients, maxDesigns, ...p } of DEFAULTS) {
    await Plan.updateOne({ code: p.code }, { $set: p }, { upsert: true });
    // the company-wide caps are set once; after that the platform admin's edits stay
    await Plan.updateOne({ code: p.code, maxClients: { $exists: false } }, { $set: { maxBranches, maxClients, maxDesigns } });
  }
  const byCode = new Map((await Plan.find()).map((p) => [p.code, p]));
  const companies = await Company.find({ $or: [{ planRef: null }, { planRef: { $exists: false } }] });
  for (const c of companies) {
    const code = LEGACY_MAP[c.plan] || 'basic';
    const plan = byCode.get(code);
    if (plan) {
      c.planRef = plan._id;
      applyPlanLimitsToCompany(c, plan);
      if (!c.subscription?.periodEnd) {
        const start = c.createdAt || new Date();
        c.subscription = { periodStart: start, periodEnd: new Date(start.getTime() + 30 * 86400000) };
      }
      if (c.limits.maxConcurrentLogins == null) c.limits.maxConcurrentLogins = plan.maxConcurrentLogins;
      await c.save();
    }
  }
}

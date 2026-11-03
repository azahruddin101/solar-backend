import { CUSTOM_PLAN_PRICING } from '../config/pricing.config.js';
import { badRequest } from '../utils/HttpError.js';

function dimCost(rules, quantity) {
  const q = Math.max(0, Number(quantity) || 0);
  const extra = Math.max(0, q - (rules.included || 0));
  return (rules.base || 0) + extra * (rules.pricePerUnit || 0);
}

function cleanLimit(value, rules, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < rules.min) throw badRequest(`${label} must be at least ${rules.min}`);
  if (n > rules.max) throw badRequest(`${label} cannot exceed ${rules.max}`);
  return Math.floor(n);
}

/** Authoritative custom plan price: concurrent sign-ins, branches, and the company-wide client and design caps. */
export function calculatePlanPrice(input) {
  const cfg = CUSTOM_PLAN_PRICING;
  const maxConcurrentLogins = cleanLimit(
    input?.maxConcurrentLogins ?? input?.concurrentLogins,
    cfg.concurrentLogins,
    'Concurrent logins',
  );

  const maxBranches = cleanLimit(input?.maxBranches ?? 1, cfg.branches, 'Branches');
  const maxClients = cleanLimit(input?.maxClients ?? cfg.clients.included, cfg.clients, 'Clients');
  const maxDesigns = cleanLimit(input?.maxDesigns ?? cfg.designs.included, cfg.designs, 'Designs');

  const round = (v) => Math.round(v * 100) / 100;
  const breakdown = {
    concurrentLogins: round(dimCost(cfg.concurrentLogins, maxConcurrentLogins)),
    branches: round(dimCost(cfg.branches, maxBranches)),
    clients: round(dimCost(cfg.clients, maxClients)),
    designs: round(dimCost(cfg.designs, maxDesigns)),
  };
  const subtotal = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const total = Math.max(cfg.minimumMonthly || 0, Math.round(subtotal * 100) / 100);

  return {
    configuration: { maxConcurrentLogins, maxBranches, maxClients, maxDesigns },
    breakdown,
    total,
    currency: cfg.currency,
    billingCycle: cfg.billingCycle,
  };
}

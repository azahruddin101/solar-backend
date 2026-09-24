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

/** Authoritative custom plan price from the three entitlement dimensions. */
export function calculatePlanPrice(input) {
  const cfg = CUSTOM_PLAN_PRICING;
  const maxClients = cleanLimit(input?.maxClients ?? input?.numberOfClients, cfg.clients, 'Clients');
  const maxDesigns = cleanLimit(input?.maxDesigns ?? input?.numberOfDesigns, cfg.designs, 'Designs');
  const maxConcurrentLogins = cleanLimit(
    input?.maxConcurrentLogins ?? input?.concurrentLogins,
    cfg.concurrentLogins,
    'Concurrent logins',
  );

  const breakdown = {
    clients: Math.round(dimCost(cfg.clients, maxClients) * 100) / 100,
    designs: Math.round(dimCost(cfg.designs, maxDesigns) * 100) / 100,
    concurrentLogins: Math.round(dimCost(cfg.concurrentLogins, maxConcurrentLogins) * 100) / 100,
  };
  const subtotal = breakdown.clients + breakdown.designs + breakdown.concurrentLogins;
  const total = Math.max(cfg.minimumMonthly || 0, Math.round(subtotal * 100) / 100);

  return {
    configuration: { maxClients, maxDesigns, maxConcurrentLogins },
    breakdown,
    total,
    currency: cfg.currency,
    billingCycle: cfg.billingCycle,
  };
}

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

/** Authoritative custom plan price. Clients and proposals are unlimited; a plan is priced on concurrent sign-ins. */
export function calculatePlanPrice(input) {
  const cfg = CUSTOM_PLAN_PRICING;
  const maxConcurrentLogins = cleanLimit(
    input?.maxConcurrentLogins ?? input?.concurrentLogins,
    cfg.concurrentLogins,
    'Concurrent logins',
  );

  const breakdown = {
    concurrentLogins: Math.round(dimCost(cfg.concurrentLogins, maxConcurrentLogins) * 100) / 100,
  };
  const subtotal = breakdown.concurrentLogins;
  const total = Math.max(cfg.minimumMonthly || 0, Math.round(subtotal * 100) / 100);

  return {
    configuration: { maxConcurrentLogins },
    breakdown,
    total,
    currency: cfg.currency,
    billingCycle: cfg.billingCycle,
  };
}

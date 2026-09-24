import { Company, Plan } from '../models/index.js';
import { badRequest, forbidden, notFound } from '../utils/HttpError.js';
import { objectId } from '../utils/validators.js';
import { applyPlanLimitsToCompany, BILLING_PERIOD_DAYS, getPlan, limitsForCompany, planSummary } from './plan.service.js';

const MS_DAY = 86400000;

function addDays(date, days) {
  return new Date(date.getTime() + days * MS_DAY);
}

function daysRemaining(periodEnd, now = new Date()) {
  return Math.max(0, Math.ceil((new Date(periodEnd).getTime() - now.getTime()) / MS_DAY));
}

/** Prorated upgrade within the current billing period (30-day cycles). */
export function quoteUpgrade({ fromPrice, toPrice, periodEnd, now = new Date() }) {
  const remaining = daysRemaining(periodEnd, now);
  if (remaining <= 0) {
    return { dueNow: toPrice, credit: 0, newCost: toPrice, daysRemaining: 0, nextRenewalAmount: toPrice, fullPeriod: true };
  }
  const credit = (fromPrice / BILLING_PERIOD_DAYS) * remaining;
  const newCost = (toPrice / BILLING_PERIOD_DAYS) * remaining;
  const dueNow = Math.max(0, Math.round((newCost - credit) * 100) / 100);
  return {
    dueNow,
    credit: Math.round(credit * 100) / 100,
    newCost: Math.round(newCost * 100) / 100,
    daysRemaining: remaining,
    nextRenewalAmount: toPrice,
    fullPeriod: false,
  };
}

async function companyPlan(company) {
  if (!company.planRef) return null;
  return Plan.findById(company.planRef);
}

export async function subscriptionView(company) {
  const plan = await companyPlan(company);
  const limits = limitsForCompany(company, plan);
  const sub = company.subscription || {};
  return {
    plan: planSummary(plan),
    limits,
    subscription: {
      periodStart: sub.periodStart || null,
      periodEnd: sub.periodEnd || null,
      daysRemaining: sub.periodEnd ? daysRemaining(sub.periodEnd) : null,
      status: sub.status || 'none',
      billingCycle: sub.billingCycle || 'monthly',
      cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    },
    renewal: {
      nextAmount: plan?.priceMonthly ?? 0,
      nextDate: sub.periodEnd || null,
      daysRemaining: sub.periodEnd ? daysRemaining(sub.periodEnd) : null,
      billingCycle: sub.billingCycle || 'monthly',
      cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    },
  };
}

export async function listUpgradeOptions(company) {
  const current = await companyPlan(company);
  if (current?.kind === 'custom') throw forbidden('Your plan is managed by the platform administrator. Contact them to change it.');
  const plans = await Plan.find({ active: true, kind: 'fixed', selfServe: true }).sort({ sortOrder: 1, priceMonthly: 1 });
  const currentPrice = current?.priceMonthly || 0;
  const periodEnd = company.subscription?.periodEnd || addDays(new Date(), BILLING_PERIOD_DAYS);
  return plans
    .filter((p) => p.priceMonthly > currentPrice)
    .map((p) => ({
      ...planSummary(p),
      quote: quoteUpgrade({ fromPrice: currentPrice, toPrice: p.priceMonthly, periodEnd }),
    }));
}

export async function quoteCompanyUpgrade(company, targetPlanId) {
  const current = await companyPlan(company);
  const target = await getPlan(targetPlanId);
  if (target.kind !== 'fixed' || !target.selfServe) throw badRequest('That plan is not available for self-serve upgrade');
  if (!current) throw badRequest('No active plan on this company');
  if (current.kind === 'custom') throw forbidden('Contact the platform administrator to change a custom plan');
  if (target.priceMonthly <= current.priceMonthly) throw badRequest('Choose a higher plan to upgrade');
  const periodEnd = company.subscription?.periodEnd || addDays(new Date(), BILLING_PERIOD_DAYS);
  return {
    current: planSummary(current),
    target: planSummary(target),
    quote: quoteUpgrade({ fromPrice: current.priceMonthly, toPrice: target.priceMonthly, periodEnd }),
  };
}

export async function assignPlanAsAdmin(company, planId, { limits } = {}) {
  const plan = await getPlan(planId);
  company.planRef = plan._id;
  if (plan.kind === 'custom' && limits) {
    if (limits.maxClients !== undefined) company.limits.maxClients = Math.max(1, Math.floor(Number(limits.maxClients)) || 1);
    if (limits.maxDesigns !== undefined) company.limits.maxDesigns = Math.max(1, Math.floor(Number(limits.maxDesigns)) || 1);
    if (limits.maxConcurrentLogins !== undefined) company.limits.maxConcurrentLogins = Math.max(1, Math.floor(Number(limits.maxConcurrentLogins)) || 1);
  } else {
    applyPlanLimitsToCompany(company, plan);
  }
  if (!company.subscription?.periodStart) {
    company.subscription = { periodStart: new Date(), periodEnd: addDays(new Date(), BILLING_PERIOD_DAYS) };
  }
  return plan;
}

export async function ensureCompanySubscription(company) {
  if (!company.subscription?.periodEnd) {
    company.subscription = {
      periodStart: company.createdAt || new Date(),
      periodEnd: addDays(company.createdAt || new Date(), BILLING_PERIOD_DAYS),
    };
    await company.save();
  }
}

export async function effectiveLimitsForCompany(company) {
  const plan = await companyPlan(company);
  return limitsForCompany(company, plan);
}

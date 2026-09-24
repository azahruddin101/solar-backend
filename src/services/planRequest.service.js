// Plan changes: the company asks (a preset plan, or a custom set of limits) and the platform admin approves or
// rejects. Payment is settled outside the app, so approval is the only thing that changes a company's plan.
import { Company, Plan, PlanRequest } from '../models/index.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import { objectId } from '../utils/validators.js';
import { calculatePlanPrice } from './pricing.service.js';
import { applyPlanLimitsToCompany, BILLING_PERIOD_DAYS, planSummary } from './plan.service.js';

const DAY = 86400000;

function requestView(doc, companyName, planDoc) {
  const j = doc.toJSON ? doc.toJSON() : doc;
  return { ...j, companyName, requestedPlan: planDoc ? planSummary(planDoc) : null };
}

const openRequestOf = (companyId) => PlanRequest.findOne({ company: companyId, status: 'pending' }).sort({ createdAt: -1 });

/** The company's most recent request (any status), so it can see how the last one ended. */
export async function getCurrentPlanRequest(company) {
  const row = await PlanRequest.findOne({ company: company._id }).sort({ createdAt: -1 });
  if (!row) return null;
  return requestView(row, company.name, row.plan ? await Plan.findById(row.plan) : null);
}

/** A limit is always a whole number of at least 1 (nothing is unlimited). Missing → `fallback`. */
function cleanLimit(v, fallback, label = 'Limit') {
  if (v === '' || v == null) return fallback;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) throw badRequest(`${label} must be at least 1`);
  return n;
}

const ALREADY_PENDING = 'You already have a plan request waiting for approval.';

export async function submitPlanRequest(company, body) {
  try {
    return await createPlanRequest(company, body);
  } catch (e) {
    if (e?.code === 11000) throw conflict(ALREADY_PENDING); // lost a race with another submit
    throw e;
  }
}

async function createPlanRequest(company, body) {
  if (await openRequestOf(company._id)) throw conflict(ALREADY_PENDING);
  const message = String(body?.message ?? '').trim();

  if (body?.type === 'preset') {
    const plan = await Plan.findById(objectId(body?.planId, 'Plan'));
    if (!plan || !plan.active || plan.kind !== 'fixed' || !plan.selfServe) throw badRequest('That plan is not available to request');
    if (String(company.planRef) === String(plan._id)) throw badRequest('You are already on this plan');
    const row = await PlanRequest.create({
      company: company._id,
      type: 'preset',
      plan: plan._id,
      message,
      requestedLimits: { maxClients: plan.maxClients, maxDesigns: plan.maxDesigns, maxConcurrentLogins: plan.maxConcurrentLogins },
    });
    return requestView(row, company.name, plan);
  }

  if (!message) throw badRequest('Describe what you need from a custom plan');
  const limits = body?.requestedLimits || {};
  const row = await PlanRequest.create({
    company: company._id,
    type: 'custom',
    message,
    requestedLimits: {
      maxClients: cleanLimit(limits.maxClients, 25, 'Clients'),
      maxDesigns: cleanLimit(limits.maxDesigns, 50, 'Designs'),
      maxConcurrentLogins: cleanLimit(limits.maxConcurrentLogins, 2, 'Concurrent sign-ins'),
    },
  });
  return requestView(row, company.name);
}

/** The company withdraws its own pending request. */
export async function cancelPlanRequest(company) {
  const row = await openRequestOf(company._id);
  if (!row) throw notFound('Plan request');
  row.status = 'cancelled';
  row.decidedAt = new Date();
  await row.save();
  return requestView(row, company.name);
}

/* ───────────── platform admin ───────────── */

export async function listPlanRequests() {
  const rows = await PlanRequest.find().sort({ createdAt: -1 }).populate('company', 'name email').populate('plan');
  return rows.map((r) => requestView(r, r.company?.name || '', r.plan));
}

async function getPending(id) {
  const row = await PlanRequest.findById(objectId(id, 'Plan request'));
  if (!row) throw notFound('Plan request');
  if (row.status !== 'pending') throw badRequest('This request has already been decided');
  return row;
}

function startNewPeriod(company, days) {
  const start = new Date();
  company.subscription.periodStart = start;
  company.subscription.periodEnd = new Date(start.getTime() + days * DAY);
  company.subscription.status = 'active';
  company.subscription.cancelAtPeriodEnd = false;
}

/**
 * Approve: a preset request moves the company onto that plan; a custom request creates a plan for the company
 * with the limits and price the admin settles on (defaults: what was asked for, priced from pricing.config.js).
 */
export async function approvePlanRequest(id, body, admin) {
  const row = await getPending(id);
  const company = await Company.findById(row.company);
  if (!company) throw notFound('Company');
  const days = Math.min(366, Math.max(1, Math.floor(Number(body?.periodDays)) || BILLING_PERIOD_DAYS));

  if (row.type === 'preset') {
    const plan = await Plan.findById(row.plan);
    if (!plan || !plan.active || plan.kind !== 'fixed') throw badRequest('The requested plan is no longer available');
    company.planRef = plan._id;
    applyPlanLimitsToCompany(company, plan);
    row.planName = plan.name;
    row.quotedPriceMonthly = plan.priceMonthly;
    row.quotedLimits = { maxClients: plan.maxClients, maxDesigns: plan.maxDesigns, maxConcurrentLogins: plan.maxConcurrentLogins };
  } else {
    const planName = String(body?.planName ?? '').trim() || `${company.name} Custom`;
    const limits = {
      maxClients: cleanLimit(body?.maxClients, row.requestedLimits.maxClients, 'Clients'),
      maxDesigns: cleanLimit(body?.maxDesigns, row.requestedLimits.maxDesigns, 'Designs'),
      maxConcurrentLogins: cleanLimit(body?.maxConcurrentLogins, row.requestedLimits.maxConcurrentLogins, 'Concurrent sign-ins'),
    };
    const priced = calculatePlanPrice(limits); // also range-checks the limits
    const priceMonthly = body?.priceMonthly === undefined || body.priceMonthly === '' ? priced.total : Number(body.priceMonthly);
    if (!Number.isFinite(priceMonthly) || priceMonthly < 0) throw badRequest('Enter a valid monthly price');
    const plan = await Plan.create({
      code: `co-${String(company._id).slice(-8)}-${Date.now().toString(36)}`.slice(0, 40),
      name: planName,
      description: `Custom plan for ${company.name}`,
      kind: 'custom',
      priceMonthly,
      ...priced.configuration,
      selfServe: false,
      active: true,
      forCompany: company._id,
    });
    company.planRef = plan._id;
    company.limits.maxClients = plan.maxClients;
    company.limits.maxDesigns = plan.maxDesigns;
    company.limits.maxConcurrentLogins = plan.maxConcurrentLogins;
    row.dedicatedPlan = plan._id;
    row.planName = planName;
    row.quotedPriceMonthly = priceMonthly;
    row.quotedLimits = priced.configuration;
  }

  startNewPeriod(company, days);
  await company.save();
  row.status = 'approved';
  row.adminNotes = body?.adminNotes ?? row.adminNotes;
  row.decidedBy = admin?._id || null;
  row.decidedAt = new Date();
  await row.save();
  return requestView(row, company.name, row.plan ? await Plan.findById(row.plan) : null);
}

export async function rejectPlanRequest(id, body, admin) {
  const row = await getPending(id);
  row.status = 'rejected';
  row.adminNotes = body?.adminNotes ?? row.adminNotes;
  row.decidedBy = admin?._id || null;
  row.decidedAt = new Date();
  await row.save();
  const company = await Company.findById(row.company);
  return requestView(row, company?.name || '', row.plan ? await Plan.findById(row.plan) : null);
}


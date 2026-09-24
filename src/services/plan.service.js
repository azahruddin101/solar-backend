import { Plan } from '../models/plan.model.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { objectId } from '../utils/validators.js';

// what a company without any recorded limit gets: a real cap, never "unlimited"
const FALLBACK_LIMITS = { maxClients: 25, maxDesigns: 50, maxConcurrentLogins: 2 };

export const BILLING_PERIOD_DAYS = 30;

const PLAN_FIELDS = ['name', 'description', 'kind', 'priceMonthly', 'maxClients', 'maxDesigns', 'maxConcurrentLogins', 'selfServe', 'active', 'sortOrder'];

const MAX_FEATURES = 20;

/** The plan's feature lines: trimmed, blanks and repeats dropped, at most 20 of up to 100 characters. */
function cleanFeatures(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw badRequest('Features must be a list');
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    if (text.length > 100) throw badRequest('A feature can be at most 100 characters');
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  if (out.length > MAX_FEATURES) throw badRequest(`A plan can list up to ${MAX_FEATURES} features`);
  return out;
}

function cleanPlanBody(body, { creating } = {}) {
  const kind = body?.kind === 'custom' ? 'custom' : 'fixed';
  const priceMonthly = Math.max(0, Number(body?.priceMonthly) || 0);
  const labels = { maxClients: 'Max clients', maxDesigns: 'Max designs', maxConcurrentLogins: 'Concurrent sign-ins' };
  const limits = Object.keys(labels).map((k) => {
    const n = Math.floor(Number(body?.[k]));
    if (!Number.isFinite(n) || n < 1) throw badRequest(`${labels[k]} must be at least 1 (plans have no unlimited option)`);
    return n;
  });
  if (kind === 'fixed' && creating && priceMonthly <= 0) throw badRequest('Fixed plans need a monthly price');
  return {
    name: String(body?.name ?? '').trim(),
    description: body?.description,
    kind,
    priceMonthly: kind === 'custom' ? 0 : priceMonthly,
    maxClients: limits[0],
    maxDesigns: limits[1],
    maxConcurrentLogins: limits[2],
    features: cleanFeatures(body?.features),
    selfServe: kind === 'custom' ? false : body?.selfServe !== false,
    active: body?.active !== false,
    sortOrder: Number(body?.sortOrder) || 0,
  };
}

export async function listPlans(filter = {}) {
  return Plan.find(filter).sort({ sortOrder: 1, createdAt: 1 });
}

export async function getPlan(id) {
  const plan = await Plan.findById(objectId(id, 'Plan'));
  if (!plan) throw notFound('Plan');
  return plan;
}

export async function getPlanByCode(code) {
  const plan = await Plan.findOne({ code: String(code).toLowerCase().trim(), active: true });
  if (!plan) throw notFound('Plan');
  return plan;
}

export async function createPlan(body) {
  const code = String(body?.code ?? '').trim().toLowerCase();
  if (!code) throw badRequest('Plan code is required');
  if (await Plan.exists({ code })) throw badRequest('That plan code is already in use');
  const data = cleanPlanBody(body, { creating: true });
  if (!data.name) throw badRequest('Plan name is required');
  return Plan.create({ code, ...data });
}

export async function updatePlan(id, body) {
  const plan = await getPlan(id);
  if (body?.code !== undefined && String(body.code).trim().toLowerCase() !== plan.code) {
    throw badRequest('Plan code cannot be changed');
  }
  const data = cleanPlanBody({ ...plan.toObject(), ...body });
  if (body?.name !== undefined && !data.name) throw badRequest('Plan name is required');
  Object.assign(plan, data);
  await plan.save();
  return plan;
}

export async function deletePlan(id) {
  const plan = await getPlan(id);
  if (['basic', 'pro', 'custom'].includes(plan.code)) throw badRequest('Built-in plans cannot be deleted. Deactivate them instead.');
  await plan.deleteOne();
}

/** Limits enforced for a company: fixed plans use plan caps; custom uses company.limits (admin-set). */
export function limitsForCompany(company, plan) {
  if (plan?.kind === 'custom') {
    return {
      maxClients: company.limits?.maxClients || FALLBACK_LIMITS.maxClients,
      maxDesigns: company.limits?.maxDesigns || FALLBACK_LIMITS.maxDesigns,
      maxConcurrentLogins: company.limits?.maxConcurrentLogins || FALLBACK_LIMITS.maxConcurrentLogins,
    };
  }
  if (plan) {
    return {
      maxClients: plan.maxClients,
      maxDesigns: plan.maxDesigns,
      maxConcurrentLogins: plan.maxConcurrentLogins,
    };
  }
  return {
    maxClients: company.limits?.maxClients || FALLBACK_LIMITS.maxClients,
    maxDesigns: company.limits?.maxDesigns || FALLBACK_LIMITS.maxDesigns,
    maxConcurrentLogins: company.limits?.maxConcurrentLogins || FALLBACK_LIMITS.maxConcurrentLogins,
  };
}

export function applyPlanLimitsToCompany(company, plan) {
  const limits = limitsForCompany(company, plan);
  company.limits.maxClients = limits.maxClients;
  company.limits.maxDesigns = limits.maxDesigns;
  company.limits.maxConcurrentLogins = limits.maxConcurrentLogins;
}

export function planSummary(plan) {
  if (!plan) return null;
  const j = plan.toJSON ? plan.toJSON() : plan;
  return {
    id: j.id,
    code: j.code,
    name: j.name,
    description: j.description,
    kind: j.kind,
    priceMonthly: j.priceMonthly,
    maxClients: j.maxClients,
    maxDesigns: j.maxDesigns,
    maxConcurrentLogins: j.maxConcurrentLogins,
    features: j.features || [],
    selfServe: j.selfServe,
    active: j.active,
  };
}

import { MASTER_FIELD_KEYS } from '../models/organizationMasters.schema.js';
import { Organization } from '../models/index.js';

/** Copy organization master fields onto a branch document for services that read req.company. */
export function applyOrganizationMasters(branch, organization) {
  if (!branch || !organization) return branch;
  const org = organization.toObject ? organization.toObject() : organization;
  const put = (key, value) => {
    if (typeof branch.set === 'function' && typeof branch.unmarkModified === 'function') {
      branch.set(key, value);
      branch.unmarkModified(key); // read from the organization, never saved onto the branch
    } else {
      branch[key] = value;
    }
  };
  for (const key of MASTER_FIELD_KEYS) {
    if (org[key] !== undefined) put(key, org[key]);
  }
  if (org.features) put('features', org.features);
  return branch;
}

export async function loadOrganizationForBranch(branch) {
  if (!branch?.organization) return null;
  return Organization.findById(branch.organization);
}

/** Branch with masters resolved from its organization when linked. */
export async function branchWithMasters(branch) {
  if (!branch) return null;
  const plain = branch.toObject ? branch.toObject() : { ...branch };
  // toObject() has no `id` virtual: the session's company.id keys every cached list and the branch switch (frontend)
  if (plain._id && !plain.id) plain.id = String(plain._id);
  const org = await loadOrganizationForBranch(branch);
  if (org) applyOrganizationMasters(plain, org);
  return plain;
}

/** Effective limits for quota checks: branch caps when set, else org pool fields on branch.limits. */
export function effectiveBranchLimits(branch, organization) {
  const limits = { ...(branch?.limits || {}) };
  if (organization?.limits) {
    for (const k of ['maxConcurrentLogins']) {
      if (limits[k] == null || limits[k] < 1) limits[k] = organization.limits[k];
    }
  }
  return limits;
}

export function masterWriteTarget(req) {
  if (req.organization) return req.organization;
  return req.company;
}

export function pickMastersFromCompanyDoc(doc) {
  const out = {};
  for (const key of MASTER_FIELD_KEYS) {
    if (doc[key] !== undefined) out[key] = doc[key];
  }
  if (doc.features) out.features = doc.features;
  return out;
}

export function pickCommercialFromCompanyDoc(doc) {
  return {
    name: doc.name,
    email: doc.email,
    phone: doc.phone,
    status: doc.status,
    plan: doc.plan,
    planRef: doc.planRef,
    limits: doc.limits,
    subscription: doc.subscription,
    features: doc.features,
    notes: doc.notes,
  };
}

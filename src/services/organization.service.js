import mongoose from 'mongoose';
import { OPEN_DESIGN_STATUS, ROLES } from '../constants/index.js';
import { Organization, Company, User, Plan, Client, Design, Project, Loan, Subsidy, Payment, Ticket, ClientTicket, EwayBill, Bill } from '../models/index.js';
import { partiesWithDue } from './receipt.service.js';
import { leadModels } from '../integrations/leads.js';
import { badRequest, forbidden, notFound } from '../utils/HttpError.js';
import { email as validEmail, objectId, password as validPassword } from '../utils/validators.js';
import { hashPassword } from '../utils/password.js';
import { pickCommercialFromCompanyDoc, pickMastersFromCompanyDoc, effectiveBranchLimits } from './tenant.service.js';
import { assignPlanAsAdmin } from './subscription.service.js';
import { applyPlanToOrganization } from './plan.service.js';
import { updateOwnCompany, updateCatalogSettings, updateLeadForm, updateInstallationSteps, updateAmcTemplates, agentRolesList } from './company.service.js';
import { updateLoanSteps } from './loan.service.js';
import { updateSubsidySteps } from './subsidy.service.js';
import { updateReasons } from './expense.service.js';
import { ownerCompanyView } from '../utils/companyView.js';
import { orgHasBranches } from '../constants/tenant.js';
import { inTransaction } from './stock.service.js';
import { dashboard as branchDashboard, inventorySnapshot } from './dashboard.service.js';

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);

/** One branch's sales & money picture (same numbers as that branch's own dashboard), trimmed for the org overview. */
function branchInsights(d) {
  const open = ['proposed', 'reproposed', 'negotiation'];
  const decided = d.stages.won.count + d.stages.lost.count;
  return {
    stages: d.stages,
    winRate: d.winRate,
    decided,
    pipelineValue: round2(open.reduce((a, s) => a + d.stages[s].value, 0)),
    pipelineCount: open.reduce((a, s) => a + d.stages[s].count, 0),
    bookedValue: d.stages.won.value,
    bookedCount: d.stages.won.count,
    bookedKwp: d.totals.wonKwp,
    money: d.money,
    revenue: d.revenue,
    activity: d.activity,
    thisMonth: d.thisMonth,
    lastMonth: d.lastMonth,
  };
}

/** Company-wide totals of the branch insights: stages, months and money added up, rates worked out again. */
function combineInsights(list) {
  const first = list[0];
  if (!first) return null;
  const stages = Object.fromEntries(Object.keys(first.stages).map((k) => [k, { count: 0, value: 0, kwp: 0 }]));
  for (const b of list) {
    for (const [k, s] of Object.entries(b.stages)) {
      stages[k].count += s.count;
      stages[k].value = round2(stages[k].value + s.value);
      stages[k].kwp = round2(stages[k].kwp + s.kwp);
    }
  }
  const sumRows = (key, fields) => first[key].map((row, i) => {
    const out = { ...row };
    for (const f of fields) out[f] = round2(list.reduce((a, b) => a + (b[key][i]?.[f] || 0), 0));
    return out;
  });
  const sum = (f) => round2(list.reduce((a, b) => a + (b[f] || 0), 0));
  const money = {
    quoted: round2(list.reduce((a, b) => a + b.money.quoted, 0)),
    billed: round2(list.reduce((a, b) => a + b.money.billed, 0)),
    yetToBill: round2(list.reduce((a, b) => a + b.money.yetToBill, 0)),
  };
  money.billedPct = money.quoted ? Math.min(100, Math.round((money.billed / money.quoted) * 100)) : 0;
  const decided = stages.won.count + stages.lost.count;
  return {
    stages,
    winRate: pct(stages.won.count, decided),
    decided,
    pipelineValue: sum('pipelineValue'),
    pipelineCount: sum('pipelineCount'),
    bookedValue: stages.won.value,
    bookedCount: stages.won.count,
    bookedKwp: sum('bookedKwp'),
    averageDeal: stages.won.count ? round2(stages.won.value / stages.won.count) : 0,
    money,
    revenue: sumRows('revenue', ['amount', 'count']),
    activity: sumRows('activity', ['created', 'won']),
    thisMonth: sum('thisMonth'),
    lastMonth: sum('lastMonth'),
  };
}

async function orgOf(user) {
  const org = await Organization.findById(user.organization);
  if (!org) throw notFound('Organization');
  if (org.status !== 'active') throw forbidden('This company account is suspended.');
  return org;
}

export async function organizationView(user, org) {
  const json = org.toJSON ? org.toJSON() : { ...org };
  return { ...json, id: String(org._id), role: 'organization', hasBranches: orgHasBranches(org) };
}

export async function getOrganization(user) {
  const org = await orgOf(user);
  return organizationView(user, org);
}

export async function listBranches(user) {
  const org = await orgOf(user);
  const branches = await Company.find({ organization: org._id }).sort({ name: 1 }).lean();
  return branches.map((b) => ({
    id: String(b._id),
    name: b.name,
    status: b.status,
    limits: b.limits,
    email: b.email,
    phone: b.phone,
  }));
}

const countByBranch = async (Model, branchIds, match = {}) => {
  const rows = await Model.aggregate([
    { $match: { company: { $in: branchIds }, ...match } },
    { $group: { _id: '$company', n: { $sum: 1 } } },
  ]);
  const map = new Map(rows.map((r) => [String(r._id), r.n]));
  return (id) => map.get(String(id)) || 0;
};

const sumByBranch = async (Model, branchIds, field, match = {}) => {
  const rows = await Model.aggregate([
    { $match: { company: { $in: branchIds }, ...match } },
    { $group: { _id: '$company', total: { $sum: `$${field}` } } },
  ]);
  const map = new Map(rows.map((r) => [String(r._id), r.total || 0]));
  return (id) => map.get(String(id)) || 0;
};

function emptyBranchCounts() {
  return {
    clients: 0,
    designs: 0,
    staff: 0,
    leads: 0,
    metaLeads: 0,
    googleLeads: 0,
    manualLeads: 0,
    leadsUnassigned: 0,
    leadsConverted: 0,
    leadsThisMonth: 0,
    leadsLastMonth: 0,
    installationsActive: 0,
    installationsCompleted: 0,
    amcInstallationsPending: 0,
    clientSupportOpen: 0,
    platformTicketsOpen: 0,
    loansOpen: 0,
    subsidiesOpen: 0,
    billingQueue: 0,
    proposalsOpen: 0,
    proposalsWon: 0,
    revenueTotal: 0,
    revenueThisMonth: 0,
  };
}

function sumInventory(branches) {
  return branches.reduce(
    (a, b) => {
      const i = b.inventory || {};
      a.products += i.products || 0;
      a.value = round2(a.value + (i.value || 0));
      a.low += i.low || 0;
      a.outOfStock += i.outOfStock || 0;
      a.needsReorder += i.needsReorder || 0;
      return a;
    },
    { products: 0, value: 0, low: 0, outOfStock: 0, needsReorder: 0 },
  );
}

function emptyInventory() {
  return { products: 0, value: 0, low: 0, outOfStock: 0, needsReorder: 0 };
}

function sumTotals(branches) {
  const t = emptyBranchCounts();
  for (const b of branches) {
    const c = b.counts;
    for (const k of Object.keys(t)) t[k] += c[k] || 0;
  }
  return t;
}

/** Company dashboard: all branches with usage and org-wide totals. */
export async function getOrganizationOverview(user) {
  const org = await orgOf(user);
  const branches = await Company.find({ organization: org._id }).sort({ name: 1 }).lean();
  const branchIds = branches.map((b) => b._id);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const liveMeta = { isDeleted: false, processingStatus: 'processed' };
  const liveLead = { isDeleted: false };

  if (!branchIds.length) {
    const maxBranches = org.limits?.maxBranches ?? 1;
    return {
      id: String(org._id),
      name: org.name,
      limits: org.limits,
      maxBranches,
      branchesUsed: 0,
      branchesRemaining: maxBranches,
      canCreateBranch: true,
      currency: org.currency || 'INR',
      branches: [],
      totals: emptyBranchCounts(),
      inventory: emptyInventory(),
      insights: null,
      generatedAt: now,
    };
  }

  const [
    clientsOf,
    designsOf,
    staffOf,
    metaLeadsOf,
    googleLeadsOf,
    manualLeadsOf,
    unMetaOf,
    unGoogleOf,
    unManualOf,
    convMetaOf,
    convGoogleOf,
    convManualOf,
    activeProjOf,
    doneProjOf,
    amcPendingOf,
    supportOf,
    ticketsOf,
    ewayOf,
    billsOf,
    wonOf,
    openOf,
    revenueOf,
    revenueMonthOf,
    loansOpenOf,
    subsidiesOpenOf,
    owners,
    newMetaOf,
    newGoogleOf,
    newManualOf,
    prevMetaOf,
    prevGoogleOf,
    prevManualOf,
    insightsList,
    inventoryList,
  ] = await Promise.all([
    countByBranch(Client, branchIds),
    countByBranch(Design, branchIds),
    countByBranch(User, branchIds, { role: ROLES.AGENT, active: true }),
    countByBranch(leadModels.meta, branchIds, liveMeta),
    countByBranch(leadModels.google, branchIds, liveLead),
    countByBranch(leadModels.manual, branchIds, liveLead),
    countByBranch(leadModels.meta, branchIds, { ...liveMeta, assignedTo: null }),
    countByBranch(leadModels.google, branchIds, { ...liveLead, assignedTo: null }),
    countByBranch(leadModels.manual, branchIds, { ...liveLead, assignedTo: null }),
    countByBranch(leadModels.meta, branchIds, { ...liveMeta, convertedClient: { $ne: null } }),
    countByBranch(leadModels.google, branchIds, { ...liveLead, convertedClient: { $ne: null } }),
    countByBranch(leadModels.manual, branchIds, { ...liveLead, convertedClient: { $ne: null } }),
    countByBranch(Project, branchIds, { status: 'active' }),
    countByBranch(Project, branchIds, { status: 'completed' }),
    countByBranch(Project, branchIds, { status: 'completed', 'amcVisits.status': 'pending' }),
    countByBranch(ClientTicket, branchIds, { status: { $in: ['open', 'in_progress'] } }),
    countByBranch(Ticket, branchIds, { status: { $in: ['open', 'in_progress'] } }),
    partiesWithDue(branchIds), // billed more than received
    Promise.resolve(() => 0), // (was: paid bills with no invoice; invoices are no longer made)
    countByBranch(Design, branchIds, { status: 'won' }),
    countByBranch(Design, branchIds, { status: { $in: OPEN_DESIGN_STATUS } }),
    sumByBranch(Payment, branchIds, 'amount'),
    sumByBranch(Payment, branchIds, 'amount', { receivedOn: { $gte: monthStart } }),
    countByBranch(Loan, branchIds, { status: 'in_progress' }),
    countByBranch(Subsidy, branchIds, { status: 'in_progress' }),
    User.find({ company: { $in: branchIds }, role: ROLES.BRANCH }).select('name email company').lean(),
    countByBranch(leadModels.meta, branchIds, { ...liveMeta, createdAt: { $gte: monthStart } }),
    countByBranch(leadModels.google, branchIds, { ...liveLead, createdAt: { $gte: monthStart } }),
    countByBranch(leadModels.manual, branchIds, { ...liveLead, createdAt: { $gte: monthStart } }),
    countByBranch(leadModels.meta, branchIds, { ...liveMeta, createdAt: { $gte: lastMonthStart, $lt: monthStart } }),
    countByBranch(leadModels.google, branchIds, { ...liveLead, createdAt: { $gte: lastMonthStart, $lt: monthStart } }),
    countByBranch(leadModels.manual, branchIds, { ...liveLead, createdAt: { $gte: lastMonthStart, $lt: monthStart } }),
    // the same sales & money numbers each branch sees on its own dashboard
    Promise.all(branches.map((b) => branchDashboard({ _id: b._id }).then(branchInsights))),
    Promise.all(branches.map((b) => inventorySnapshot(b))),
  ]);

  const ownerByBranch = new Map(owners.map((o) => [String(o.company), { name: o.name || '', email: o.email || '' }]));

  const maxBranches = org.limits?.maxBranches ?? 1;
  const mapped = branches.map((b, i) => {
    const metaLeads = metaLeadsOf(b._id);
    const googleLeads = googleLeadsOf(b._id);
    const manualLeads = manualLeadsOf(b._id);
    const counts = {
      clients: clientsOf(b._id),
      designs: designsOf(b._id),
      staff: staffOf(b._id),
      leads: metaLeads + googleLeads + manualLeads,
      metaLeads,
      googleLeads,
      manualLeads,
      leadsUnassigned: unMetaOf(b._id) + unGoogleOf(b._id) + unManualOf(b._id),
      leadsConverted: convMetaOf(b._id) + convGoogleOf(b._id) + convManualOf(b._id),
      leadsThisMonth: newMetaOf(b._id) + newGoogleOf(b._id) + newManualOf(b._id),
      leadsLastMonth: prevMetaOf(b._id) + prevGoogleOf(b._id) + prevManualOf(b._id),
      installationsActive: activeProjOf(b._id),
      installationsCompleted: doneProjOf(b._id),
      amcInstallationsPending: amcPendingOf(b._id),
      clientSupportOpen: supportOf(b._id),
      platformTicketsOpen: ticketsOf(b._id),
      loansOpen: loansOpenOf(b._id),
      subsidiesOpen: subsidiesOpenOf(b._id),
      billingQueue: ewayOf(b._id) + billsOf(b._id),
      proposalsOpen: openOf(b._id),
      proposalsWon: wonOf(b._id),
      revenueTotal: Math.round((revenueOf(b._id) || 0) * 100) / 100,
      revenueThisMonth: Math.round((revenueMonthOf(b._id) || 0) * 100) / 100,
    };
    const limits = b.limits || {};
    return {
      id: String(b._id),
      name: b.name,
      status: b.status,
      email: b.email || '',
      phone: b.phone || '',
      limits,
      owner: ownerByBranch.get(String(b._id)) || null,
      counts,
      inventory: inventoryList[i] || emptyInventory(),
      insights: insightsList[i],
    };
  });

  return {
    id: String(org._id),
    name: org.name,
    limits: org.limits,
    maxBranches,
    branchesUsed: branches.length,
    branchesRemaining: Math.max(0, maxBranches - branches.length),
    canCreateBranch: branches.length < maxBranches,
    currency: org.currency || 'INR',
    branches: mapped,
    totals: sumTotals(mapped),
    inventory: sumInventory(mapped),
    insights: combineInsights(insightsList),
    generatedAt: now,
  };
}

function sumBranchCaps(branches, field) {
  return branches.reduce((a, b) => a + (Number(b.limits?.[field]) || 0), 0);
}

function assertCapsWithinPool(org, branches, patch) {
  const next = branches.map((b) => (String(b._id) === String(patch.id) ? { ...b, limits: { ...b.limits, ...patch.limits } } : b));
  for (const field of ['maxConcurrentLogins']) {
    const pool = org.limits?.[field] || 0;
    const sum = sumBranchCaps(next, field);
    if (sum > pool) throw badRequest(`Total branch ${field} (${sum}) cannot exceed the company pool (${pool}).`);
  }
}

/** A sign-in email someone else took between our check and the write (unique index) → the same friendly error. */
async function emailsFree(work) {
  try {
    return await work();
  } catch (err) {
    if (err?.code === 11000 && err?.keyPattern?.email) throw badRequest('That email is already in use');
    throw err;
  }
}

/**
 * Locks the organization's branch set for this transaction: two branch creates / cap changes at the same moment both
 * write the same document, so one of them conflicts and is retried after the other committed — limits always hold.
 */
async function lockBranches(orgId, session) {
  const org = await Organization.findOneAndUpdate({ _id: orgId }, { $inc: { branchVersion: 1 } }, { session, new: true });
  if (!org) throw notFound('Organization');
  return org;
}

/** A new branch in a company with branches, with its own owner signing in on an email of their own. */
export async function createBranch(user, body) {
  const { _id: orgId } = await orgOf(user);
  const name = String(body?.name ?? '').trim();
  if (!name) throw badRequest('Branch name is required');
  if (!body?.ownerEmail || !body?.ownerPassword) throw badRequest('Enter the branch owner’s email and password');
  const ownerEmail = validEmail(body.ownerEmail);
  const passwordHash = await hashPassword(validPassword(body.ownerPassword));

  return emailsFree(() => inTransaction(async (session) => {
    const org = await lockBranches(orgId, session);
    if (!orgHasBranches(org)) throw badRequest('This company was set up without branches. Contact the platform administrator.');
    if (await User.exists({ email: ownerEmail }).session(session)) throw badRequest('That branch owner email is already in use');
    const branches = await Company.find({ organization: org._id }).session(session).lean();
    const maxBranches = org.limits?.maxBranches ?? 1;
    if (branches.length >= maxBranches) {
      throw badRequest(`This company can have at most ${maxBranches} branch${maxBranches === 1 ? '' : 'es'}. Contact the platform administrator to increase the limit.`);
    }
    const limits = { maxConcurrentLogins: 1 };
    assertCapsWithinPool(org, [...branches, { _id: 'new', limits }], { id: 'new', limits });

    const [branch] = await Company.create([{ organization: org._id, name, email: body?.email, phone: body?.phone, status: 'active', limits }], { session });
    const [owner] = await User.create([{ email: ownerEmail, passwordHash, role: ROLES.BRANCH, name: String(body?.ownerName ?? '').trim(), company: branch._id, organization: org._id }], { session });
    return { branch: { id: String(branch._id), name: branch.name, limits: branch.limits }, owner: { id: String(owner._id), email: owner.email } };
  }));
}

export async function updateBranchCaps(user, branchId, body) {
  const patch = pick(body?.limits || body, ['maxConcurrentLogins']);
  if (patch.maxConcurrentLogins != null) {
    throw badRequest('Each branch allows one signed-in device. This limit cannot be changed here.');
  }
  throw badRequest('No branch limits to update.');
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Masters live on the organization document. */
async function mastersDoc(user) {
  return orgOf(user);
}

export async function updateOrgCompany(body, user) {
  const org = await mastersDoc(user);
  return updateOwnCompany(org, body);
}

export async function updateOrgCatalogSettings(body, user) {
  const org = await mastersDoc(user);
  return updateCatalogSettings(org, body);
}

export async function updateOrgLeadForm(body, user) {
  const org = await mastersDoc(user);
  return updateLeadForm(org, body);
}

export async function updateOrgInstallationSteps(body, user) {
  const org = await mastersDoc(user);
  return updateInstallationSteps(org, body);
}

export async function updateOrgAmcTemplates(body, user) {
  const org = await mastersDoc(user);
  return updateAmcTemplates(org, body);
}

export async function updateOrgLoanSteps(body, user) {
  const org = await mastersDoc(user);
  return updateLoanSteps(org, body);
}

export async function updateOrgSubsidySteps(body, user) {
  const org = await mastersDoc(user);
  return updateSubsidySteps(org, body);
}

export async function updateOrgExpenseReasons(body, user) {
  const org = await mastersDoc(user);
  return updateReasons(org, body);
}

/**
 * The platform admin creates a company. It is set up one of two ways, chosen here once:
 *  - without branches (`hasBranches` false): one workspace and one sign-in — `loginEmail` is its owner (role branch),
 *    who also manages the masters;
 *  - with branches: `loginEmail` is the company admin (role company), and the first branch gets its own owner with
 *    their own email (`branchOwnerEmail`); the admin adds more branches later, each with its own owner.
 * Everything is written in one transaction: a refused or failed request leaves nothing behind.
 */
export async function createOrganizationWithBranch(body) {
  const hasBranches = body?.hasBranches === true || body?.hasBranches === 'true';
  const name = String(body?.name ?? '').trim();
  if (!name) throw badRequest('Company name is required');
  const loginEmail = validEmail(body?.loginEmail);
  const passwordHash = await hashPassword(validPassword(body?.password));

  let branchOwner = null;
  if (hasBranches) {
    if (!body?.branchOwnerEmail) throw badRequest('Enter the email of the first branch’s owner');
    const email = validEmail(body.branchOwnerEmail);
    if (email === loginEmail) throw badRequest('The branch owner needs a different email from the company admin');
    branchOwner = { email, passwordHash: await hashPassword(validPassword(body?.branchOwnerPassword)), name: String(body?.branchOwnerName ?? '').trim() };
  }
  const plan = body?.planId && mongoose.isValidObjectId(body.planId) ? await Plan.findById(body.planId) : null;

  return emailsFree(() => inTransaction(async (session) => {
    for (const email of [loginEmail, branchOwner?.email].filter(Boolean)) {
      if (await User.exists({ email }).session(session)) throw badRequest(email === loginEmail ? 'That login email is already in use' : 'That branch owner email is already in use');
    }

    const org = new Organization({ name, email: loginEmail, ...pickCommercialFromCompanyDoc({ ...body, name }), hasBranches });
    org.limits.maxBranches = hasBranches ? Math.max(1, Math.floor(Number(body?.limits?.maxBranches)) || 1) : 1;
    org.limits.maxClients = Math.max(1, Math.floor(Number(body?.limits?.maxClients)) || org.limits.maxClients);
    org.limits.maxDesigns = Math.max(1, Math.floor(Number(body?.limits?.maxDesigns)) || org.limits.maxDesigns);
    if (plan) {
      await assignPlanAsAdmin(org, plan.id, { limits: org.limits });
      // a fixed plan sets the caps; numbers typed on the form (custom plans) win
      applyPlanToOrganization(org, plan, { maxBranches: hasBranches ? body?.limits?.maxBranches : 1, maxClients: body?.limits?.maxClients, maxDesigns: body?.limits?.maxDesigns });
      org.subscription = { periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000) };
    }
    await org.save({ session });

    const [branch] = await Company.create([{
      organization: org._id,
      name: hasBranches ? String(body?.branchName ?? '').trim() || `${name} — Main` : name,
      email: hasBranches ? branchOwner.email : loginEmail,
      phone: body?.phone,
      address: body?.address,
      website: body?.website,
      taxId: body?.taxId,
      pan: body?.pan,
      limits: { maxConcurrentLogins: org.limits.maxConcurrentLogins },
      status: body?.status || 'active',
    }], { session });

    const users = hasBranches
      ? [
        { email: loginEmail, passwordHash, role: ROLES.COMPANY, name: String(body?.contactName ?? '').trim(), organization: org._id, company: branch._id },
        { email: branchOwner.email, passwordHash: branchOwner.passwordHash, role: ROLES.BRANCH, name: branchOwner.name, organization: org._id, company: branch._id },
      ]
      : [{ email: loginEmail, passwordHash, role: ROLES.BRANCH, name: String(body?.contactName ?? '').trim(), organization: org._id, company: branch._id }];
    await User.create(users, { session, ordered: true });

    return { branchId: branch._id, organizationId: org._id, hasBranches };
  }));
}

export { agentRolesList };

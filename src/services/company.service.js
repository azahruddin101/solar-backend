// Companies: the super admin's management operations and the company's own profile.
import mongoose from 'mongoose';
import { DEFAULT_AGENT_ROLES, DEFAULT_STEP_PRIORITY, ROLES, STEP_PRIORITIES } from '../constants/index.js';
import { AuthSession, Client, Company, Design, Notification, Organization, Plan, Product, User } from '../models/index.js';
import { applyPlanLimitsToCompany, planSummary } from './plan.service.js';
import { parseInvoiceNumbering } from './invoiceNumber.service.js';
import { assignPlanAsAdmin, ensureCompanySubscription, subscriptionView } from './subscription.service.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/HttpError.js';
import { hashPassword } from '../utils/password.js';
import { pick } from '../utils/pick.js';
import { capFirst } from '../utils/text.js';
import { cleanRichText } from '../utils/richText.js';
import { signToken } from '../utils/token.js';
import { email as validEmail, objectId, password as validPassword } from '../utils/validators.js';
import { deleteCompanyAssets } from './asset.service.js';
import { deleteCompanyData } from './companyData.js';
import { ownerCompanyView } from '../utils/companyView.js';
import { managesMasters, orgHasBranches } from '../constants/tenant.js';
import { applyOrganizationMasters } from './tenant.service.js';
import { deleteByPrefix } from './storage.service.js';
import { newSessionId, registerSession, revokeUserSessions } from './session.service.js';
import { deleteTicketsForCompany } from './ticket.service.js';
import { deleteClientTicketsForCompany } from './clientTicket.service.js';
import { leadForm } from '../integrations/leads.js';


const PROFILE = ['name', 'email', 'phone', 'address', 'website', 'taxId', 'pan'];
const ADMIN_CONTROLS = ['status', 'notes'];
const SELF_EDITABLE = [...PROFILE, 'signatoryName', 'signatoryTitle', 'qrLabel', 'tagline', 'pdfTerms', 'currency', 'tariff', 'otherCostPerKw'];
const MAX_PRODUCT_UNITS = 30;
const MAX_AGENT_ROLES = 30;

/** Trim, de-dupe (case-insensitive), and validate the company's agent role labels. */
function cleanAgentRoles(roles) {
  if (!Array.isArray(roles)) throw badRequest('Invalid roles');
  const out = [];
  const seen = new Set();
  for (const r of roles) {
    const label = String(r ?? '').trim();
    if (!label) continue;
    if (label.length > 40) throw badRequest('A role name can be at most 40 characters');
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  if (!out.length) throw badRequest('Keep at least one role');
  if (out.length > MAX_AGENT_ROLES) throw badRequest(`You can have up to ${MAX_AGENT_ROLES} roles`);
  return out;
}

export function agentRolesList(company) {
  const raw = company?.agentRoles;
  return Array.isArray(raw) && raw.length ? raw : DEFAULT_AGENT_ROLES;
}

/** Empty string allowed; otherwise must match a company role label. */
export function resolveAgentRole(company, label) {
  const trimmed = String(label ?? '').trim();
  if (!trimmed) return '';
  const match = agentRolesList(company).find((r) => r.toLowerCase() === trimmed.toLowerCase());
  if (!match) throw badRequest('Choose a role from your list');
  return match;
}

/** Trim, de-dupe (case-insensitive), and validate the company's catalog unit labels. */
function cleanProductUnits(units) {
  if (!Array.isArray(units)) throw badRequest('Invalid units');
  const out = [];
  const seen = new Set();
  for (const u of units) {
    const label = capFirst(u);
    if (!label) continue;
    if (label.length > 20) throw badRequest('A unit name can be at most 20 characters');
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  if (!out.length) throw badRequest('Keep at least one unit');
  if (out.length > MAX_PRODUCT_UNITS) throw badRequest(`You can have up to ${MAX_PRODUCT_UNITS} units`);
  return out;
}

function applyAdminFields(company, body) {
  Object.assign(company, pick(body, [...PROFILE, ...ADMIN_CONTROLS]));
  if (body?.limits) Object.assign(company.limits, pick(body.limits, ['maxConcurrentLogins']));
  if (body?.features) Object.assign(company.features, pick(body.features, ['pdfBranding', 'excelImport']));
}

const countByCompany = async (Model, match = {}) => new Map((await Model.aggregate([{ $match: match }, { $group: { _id: '$company', n: { $sum: 1 } } }])).map((r) => [String(r._id), r.n]));

async function getOrFail(id) {
  const company = await Company.findById(objectId(id, 'Company'));
  if (!company) throw notFound('Company');
  return company;
}

const loginOf = (companyId) => User.findOne({ company: companyId, role: ROLES.BRANCH });
/** The company admin of the organization a branch belongs to (only companies with branches have one). */
const adminOf = async (company) => (company.organization ? User.findOne({ organization: company.organization, role: ROLES.COMPANY }) : null);

/** Deletes logins with their sessions and inbox. */
async function removeUsersCompletely(ids) {
  if (!ids.length) return;
  await Promise.all([AuthSession.deleteMany({ user: { $in: ids } }), Notification.deleteMany({ user: { $in: ids } })]);
  await User.deleteMany({ _id: { $in: ids } });
}

/** A new sign-in email for `user`, checked against every other login. */
async function changeEmail(user, raw) {
  const next = validEmail(raw);
  if (user.email === next) return;
  if (await User.exists({ email: next, _id: { $ne: user._id } })) throw conflict('That email is already in use');
  user.email = next;
}

import { createOrganizationWithBranch } from './organization.service.js';

/** Companies with their login email and usage counts. */
export async function listCompanies(filter = {}) {
  const [companies, users, clients, designs, panels] = await Promise.all([
    Company.find(filter).sort({ createdAt: -1 }),
    User.find({ role: ROLES.BRANCH }),
    countByCompany(Client),
    countByCompany(Design),
    countByCompany(Product, { type: 'panels' }),
  ]);
  const login = new Map(users.map((u) => [String(u.company), u]));
  const plans = new Map((await Plan.find()).map((p) => [p.id, p]));
  const orgIds = [...new Set(companies.map((c) => String(c.organization || '')).filter(Boolean))];
  const [orgs, admins] = await Promise.all([
    Organization.find({ _id: { $in: orgIds } }).select('name hasBranches limits').lean(),
    User.find({ organization: { $in: orgIds }, role: ROLES.COMPANY }).select('email organization').lean(),
  ]);
  const orgById = new Map(orgs.map((o) => [String(o._id), o]));
  const adminOf = new Map(admins.map((u) => [String(u.organization), u.email]));
  return companies.map((c) => {
    const plan = plans.get(String(c.planRef));
    const org = orgById.get(String(c.organization || ''));
    return {
      ...c.toJSON(),
      organizationName: org?.name || '',
      hasBranches: org ? orgHasBranches(org) : false,
      maxBranches: org?.limits?.maxBranches ?? 1,
      poolLogins: org?.limits?.maxConcurrentLogins ?? null, // with branches: the company-wide sign-in pool the admin edits
      adminEmail: org && orgHasBranches(org) ? adminOf.get(String(org._id)) || '' : '',
      plan: plan?.code || c.plan,
      planId: plan?.id || c.planRef || '',
      planDetail: planSummary(plan),
      loginEmail: login.get(c.id)?.email || '',
      contactName: login.get(c.id)?.name || '',
      lastLoginAt: login.get(c.id)?.lastLoginAt || null,
      counts: { clients: clients.get(c.id) || 0, designs: designs.get(c.id) || 0, panels: panels.get(c.id) || 0 },
    };
  });
}

const describe = async (company) => (await listCompanies({ _id: company._id }))[0];

export async function platformStats() {
  const [companies, active, clients, designs, kwp] = await Promise.all([
    Company.countDocuments(),
    Company.countDocuments({ status: 'active' }),
    Client.countDocuments(),
    Design.countDocuments(),
    Design.aggregate([{ $group: { _id: null, kwp: { $sum: '$summary.kwp' } } }]),
  ]);
  return { companies, active, suspended: companies - active, clients, designs, kwp: kwp[0]?.kwp || 0 };
}

export async function createCompany(body) {
  const { branchId } = await createOrganizationWithBranch(body);
  return (await listCompanies({ _id: branchId }))[0];
}

/**
 * The platform admin edits a company row (a branch). Sign-in limits:
 *  - without branches the company and its one branch share the same number;
 *  - with branches it is the company-wide pool, which the company admin shares out between branches — so it can't go
 *    below what the branches already hold, and the branch cap itself is left to the company admin.
 * Everything is checked before anything is written.
 */
export async function updateCompanyAsAdmin(id, body) {
  const company = await getOrFail(id);
  const org = company.organization ? await Organization.findById(company.organization) : null;
  const withBranches = orgHasBranches(org);
  const whole = (v) => Math.max(1, Math.floor(Number(v)) || 1);
  // only what actually changes is checked and written: re-saving a form never trips over the current numbers
  const changed = (v, now) => (v != null && whole(v) !== now ? whole(v) : null);
  const logins = changed(body?.limits?.maxConcurrentLogins, withBranches ? org.limits?.maxConcurrentLogins : company.limits?.maxConcurrentLogins);
  const maxBranches = withBranches ? changed(body?.limits?.maxBranches, org.limits?.maxBranches) : null;
  if (withBranches) {
    const branches = await Company.find({ organization: org._id }).select('limits').lean();
    const held = branches.reduce((a, b) => a + (Number(b.limits?.maxConcurrentLogins) || 0), 0);
    if (logins != null && logins < held) throw badRequest(`The branches already hold ${held} sign-ins between them. Ask the company admin to lower a branch’s limit first, or allow at least ${held}.`);
    if (maxBranches != null && maxBranches < branches.length) throw badRequest(`This company already has ${branches.length} branches; the limit can’t be lower.`);
  }

  applyAdminFields(company, { ...body, limits: withBranches ? undefined : body?.limits });
  if (body?.planId) await assignPlanAsAdmin(company, body.planId, { limits: company.limits });
  await ensureCompanySubscription(company);
  await company.save();
  // feature switches are shared by the whole company (read from the organization)
  if (org && body?.features) Object.assign(org.features, pick(body.features, ['pdfBranding', 'excelImport']));
  if (org && (logins != null || maxBranches != null || body?.features)) {
    if (logins != null) org.limits.maxConcurrentLogins = logins;
    if (maxBranches != null) org.limits.maxBranches = maxBranches; // a company without branches always keeps exactly one
    await org.save();
  }
  const user = await loginOf(company._id);
  if (user && body?.loginEmail !== undefined) await changeEmail(user, body.loginEmail);
  if (user && typeof body?.contactName === 'string') user.name = body.contactName;
  if (user?.isModified()) await user.save();
  // the company admin of a company with branches (its own sign-in, separate from this branch's owner)
  if (body?.adminEmail !== undefined && body.adminEmail !== '') {
    const admin = await adminOf(company);
    if (!admin) throw badRequest('This company has no company admin: it was set up without branches');
    await changeEmail(admin, body.adminEmail);
    if (admin.isModified()) await admin.save();
  }
  return describe(company);
}

/** `who`: 'owner' (the branch owner — the default) or 'admin' (the company admin of a company with branches). */
export async function resetCompanyPassword(id, plain, who = 'owner') {
  const company = await getOrFail(id);
  const user = who === 'admin' ? await adminOf(company) : await loginOf(company._id);
  if (!user) throw notFound(who === 'admin' ? 'Company admin login' : 'Company login');
  user.passwordHash = await hashPassword(validPassword(plain));
  user.tokenVersion = (user.tokenVersion || 0) + 1; // any token the old password produced (or that was stolen) stops working
  await user.save();
  await revokeUserSessions(user._id);
}

/** Open the company's workspace as them (short-lived token, flagged as impersonation). */
export async function impersonate(id, admin) {
  const company = await getOrFail(id);
  if (company.status !== 'active') throw badRequest('Activate the company before signing in as it');
  const user = await loginOf(company._id);
  if (!user) throw notFound('Company login');
  const sid = newSessionId();
  await registerSession({ user: admin, sessionId: sid, userAgent: 'impersonation', impersonation: true }); // ends when the admin leaves the company (or after 2 h)
  return { token: signToken(user, { by: admin.id, sid }), user, company: await ownerCompanyView(company), impersonated: true };
}

/**
 * Deletes one branch (the platform's "company" row) and everything in it. Its organization is looked after too:
 *  - the organization's last branch (always so for a company without branches): the organization and its company
 *    admin go with it — nothing is left that can sign in to an empty company;
 *  - otherwise the company admin, who works inside one branch at a time, is moved to another branch first (its user
 *    row points at a branch, and every user of the deleted branch is deleted) and signed out of the deleted one.
 */
export async function deleteCompany(id) {
  const company = await getOrFail(id);
  if (company.organization) {
    const others = await Company.find({ organization: company.organization, _id: { $ne: company._id } }).select('_id status createdAt').sort({ createdAt: 1 }).lean();
    const admins = await User.find({ organization: company.organization, role: ROLES.COMPANY }).select('_id company').lean();
    if (!others.length) {
      await removeUsersCompletely(admins.map((a) => a._id));
      await Organization.deleteOne({ _id: company.organization });
      await deleteByPrefix(`${company.organization}-`); // the company's shared branding images
    } else {
      const home = others.find((b) => b.status === 'active') || others[0];
      const moved = admins.filter((a) => String(a.company) === String(company._id)).map((a) => a._id);
      if (moved.length) await User.updateMany({ _id: { $in: moved } }, { $set: { company: home._id } });
    }
  }
  await deleteCompanyData(company._id);
  await deleteTicketsForCompany(company._id);
  await deleteClientTicketsForCompany(company._id);
  await company.deleteOne();
  await deleteCompanyAssets(company.id);
}

/** A company editing itself: profile, branding text, theme and pricing — never status, plan or limits. */
export async function updateOwnCompany(company, body) {
  Object.assign(company, pick(body, SELF_EDITABLE));
  if (body?.pdfTerms !== undefined) company.pdfTerms = cleanRichText(body.pdfTerms);
  if (body?.theme) Object.assign(company.theme, pick(body.theme, ['primary', 'accent']));
  if (body?.productUnits !== undefined) company.productUnits = cleanProductUnits(body.productUnits);
  if (body?.agentRoles !== undefined) company.agentRoles = cleanAgentRoles(body.agentRoles);
  if (body?.invoiceNumbering !== undefined) company.invoiceNumbering = await parseInvoiceNumbering(company, body.invoiceNumbering);
  await company.save();
  return company;
}

/** Settings on the company Settings page that every branch shares: saved on the organization (see companyMasters.plugin.js). */
const SHARED_SETTINGS = ['signatoryName', 'signatoryTitle', 'qrLabel', 'tagline', 'pdfTerms', 'currency', 'tariff', 'otherCostPerKw', 'theme', 'productUnits', 'agentRoles'];

const plainList = (v) => (Array.isArray(v) ? [...v].map(String) : []);
/** Whether a submitted shared setting differs from what is in force (forms send every field back, changed or not). */
function changesSetting(key, next, current) {
  if (next === undefined) return false;
  if (key === 'theme') return ['primary', 'accent'].some((k) => next?.[k] !== undefined && String(next[k]).toLowerCase() !== String(current?.[k] ?? '').toLowerCase());
  if (key === 'pdfTerms') return cleanRichText(next ?? '') !== String(current ?? '');
  if (key === 'productUnits') return JSON.stringify(cleanProductUnits(next)) !== JSON.stringify(plainList(current));
  if (key === 'agentRoles') return JSON.stringify(cleanAgentRoles(next)) !== JSON.stringify(plainList(current));
  if (['tariff', 'otherCostPerKw'].includes(key)) return Number(next) !== Number(current);
  return String(next ?? '').trim() !== String(current ?? '').trim();
}

/**
 * The company Settings page (PUT /api/company). Each field goes where it lives:
 *  - shared settings (branding, PDF terms, pricing, units, job titles) on the organization - only by whoever manages the
 *    masters (the company admin, or the owner of a company without branches); a branch owner may send them back
 *    unchanged with the rest of the form, but not change them;
 *  - the branch's own profile and its invoice numbering on the branch.
 */
export async function saveCompanySettings({ company, organization, user }, body = {}) {
  if (!organization) return updateOwnCompany(company, body);
  const shared = {};
  const own = {};
  for (const [key, value] of Object.entries(body || {})) (SHARED_SETTINGS.includes(key) ? shared : own)[key] = value;
  const changed = Object.keys(shared).filter((key) => changesSetting(key, shared[key], company[key]));
  if (changed.length) {
    if (!managesMasters(user, organization)) throw forbidden('Branding, PDF terms, pricing, units and job titles are set by your company admin for every branch.');
    await updateOwnCompany(organization, pick(shared, changed));
    applyOrganizationMasters(company, organization);
  }
  if (Object.keys(own).length) await updateOwnCompany(company, own);
  return company;
}

const CATALOG_SELF_EDITABLE = ['currency', 'tariff', 'otherCostPerKw'];

/** Product units and default pricing (currency, tariff, balance-of-system cost): company masters, owner only (see company.routes.js). */
export async function updateCatalogSettings(company, body) {
  Object.assign(company, pick(body, CATALOG_SELF_EDITABLE));
  if (body?.productUnits !== undefined) company.productUnits = cleanProductUnits(body.productUnits);
  await company.save();
  return company;
}

/** The company's own lead-form fields (a master). Fields keep their storage key, so existing answers stay linked. */
export async function updateLeadForm(company, body) {
  try {
    company.leadForm = leadForm.parseLeadForm(body?.fields, company.leadForm || []);
  } catch (e) {
    if (e instanceof leadForm.LeadFormError) throw badRequest(e.message);
    throw e;
  }
  await company.save();
  return leadForm.formOf(company);
}

/** A step's priority: 'medium' when none is given. */
export function stepPriority(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_STEP_PRIORITY;
  if (!STEP_PRIORITIES.includes(value)) throw badRequest('Invalid step priority');
  return value;
}

export { updateAmcTemplates } from './amc.service.js';

/** The installation step template. Replaced as a whole; running installations keep the steps they started with. */
export async function updateInstallationSteps(company, body) {
  if (!Array.isArray(body?.steps)) throw badRequest('Steps are required');
  if (body.steps.length > 30) throw badRequest('You can have up to 30 steps');
  company.installationSteps = body.steps.map((s) => {
    const name = String(s?.name ?? '').trim();
    if (!name) throw badRequest('Step name is required');
    return { name, description: s?.description, role: resolveAgentRole(company, s?.role), priority: stepPriority(s?.priority) };
  });
  await company.save();
  return company.installationSteps;
}

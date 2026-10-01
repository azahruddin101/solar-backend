// Companies: the super admin's management operations and the company's own profile.
import mongoose from 'mongoose';
import { DEFAULT_AGENT_ROLES, DEFAULT_STEP_PRIORITY, ROLES, STEP_PRIORITIES } from '../constants/index.js';
import { Category, Client, Company, Design, ParentCategory, Invoice, InstallationCharge, Payment, Counter, Package, Plan, Product, Project, User } from '../models/index.js';
import { applyPlanLimitsToCompany, planSummary } from './plan.service.js';
import { parseInvoiceNumbering } from './invoiceNumber.service.js';
import { assignPlanAsAdmin, ensureCompanySubscription, subscriptionView } from './subscription.service.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import { hashPassword } from '../utils/password.js';
import { pick } from '../utils/pick.js';
import { capFirst } from '../utils/text.js';
import { cleanRichText } from '../utils/richText.js';
import { signToken } from '../utils/token.js';
import { email as validEmail, objectId, password as validPassword } from '../utils/validators.js';
import { deleteCompanyAssets } from './asset.service.js';
import { ownerCompanyView } from '../utils/companyView.js';
import { newSessionId, registerSession, revokeUserSessions } from './session.service.js';
import { deleteTicketsForCompany } from './ticket.service.js';

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
  if (body?.limits) Object.assign(company.limits, pick(body.limits, ['maxClients', 'maxDesigns', 'maxConcurrentLogins']));
  if (body?.features) Object.assign(company.features, pick(body.features, ['pdfBranding', 'excelImport']));
}

const countByCompany = async (Model, match = {}) => new Map((await Model.aggregate([{ $match: match }, { $group: { _id: '$company', n: { $sum: 1 } } }])).map((r) => [String(r._id), r.n]));

async function getOrFail(id) {
  const company = await Company.findById(objectId(id, 'Company'));
  if (!company) throw notFound('Company');
  return company;
}

const loginOf = (companyId) => User.findOne({ company: companyId, role: ROLES.COMPANY });

/** Companies with their login email and usage counts. */
export async function listCompanies(filter = {}) {
  const [companies, users, clients, designs, panels] = await Promise.all([
    Company.find(filter).sort({ createdAt: -1 }),
    User.find({ role: ROLES.COMPANY }),
    countByCompany(Client),
    countByCompany(Design),
    countByCompany(Product, { type: 'panels' }),
  ]);
  const login = new Map(users.map((u) => [String(u.company), u]));
  const plans = new Map((await Plan.find()).map((p) => [p.id, p]));
  return companies.map((c) => {
    const plan = plans.get(String(c.planRef));
    return {
      ...c.toJSON(),
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
  const loginEmail = validEmail(body?.loginEmail);
  const plain = validPassword(body?.password);
  if (!String(body?.name ?? '').trim()) throw badRequest('Company name is required');
  if (await User.exists({ email: loginEmail })) throw conflict('That login email is already in use');

  const company = new Company({ name: body.name, email: loginEmail });
  applyAdminFields(company, body);
  let chosenPlan = await Plan.findOne({ code: 'basic' });
  if (body?.planId && mongoose.isValidObjectId(body.planId)) {
    chosenPlan = (await Plan.findById(body.planId)) || chosenPlan;
  }
  if (chosenPlan) {
    await assignPlanAsAdmin(company, chosenPlan.id, { limits: company.limits });
    company.subscription = { periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000) };
  }
  await company.save();
  let user;
  try {
    user = await User.create({ email: loginEmail, passwordHash: await hashPassword(plain), role: ROLES.COMPANY, name: body.contactName || '', company: company._id });
  } catch (e) {
    await User.deleteOne({ _id: user?._id }).catch(() => {});
    await company.deleteOne();
    throw e;
  }
  return describe(company);
}

export async function updateCompanyAsAdmin(id, body) {
  const company = await getOrFail(id);
  applyAdminFields(company, body);
  if (body?.planId) await assignPlanAsAdmin(company, body.planId, { limits: company.limits });
  await ensureCompanySubscription(company);
  await company.save();
  const user = await loginOf(company._id);
  if (user && body?.loginEmail !== undefined) {
    const loginEmail = validEmail(body.loginEmail);
    if (user.email !== loginEmail) {
      if (await User.exists({ email: loginEmail })) throw conflict('That login email is already in use');
      user.email = loginEmail;
    }
  }
  if (user && typeof body?.contactName === 'string') user.name = body.contactName;
  if (user?.isModified()) await user.save();
  return describe(company);
}

export async function resetCompanyPassword(id, plain) {
  const user = await loginOf(objectId(id, 'Company'));
  if (!user) throw notFound('Company login');
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

export async function deleteCompany(id) {
  const company = await getOrFail(id);
  const filter = { company: company._id };
  await Promise.all([
    Project.deleteMany(filter),
    Design.deleteMany(filter),
    Client.deleteMany(filter),
    Product.deleteMany(filter),
    Category.deleteMany(filter),
    ParentCategory.deleteMany(filter),
    Package.deleteMany(filter),
    InstallationCharge.deleteMany(filter),
    Payment.deleteMany(filter),
    Invoice.deleteMany(filter),
    Counter.deleteMany(filter),
    User.deleteMany(filter),
  ]);
  await deleteTicketsForCompany(company._id);
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

const CATALOG_SELF_EDITABLE = ['currency', 'tariff', 'otherCostPerKw'];

/** The narrow slice of company settings a staff member with the "catalog" permission may change: product units and default pricing — never branding, contact info, or anything else `updateOwnCompany` covers. */
export async function updateCatalogSettings(company, body) {
  Object.assign(company, pick(body, CATALOG_SELF_EDITABLE));
  if (body?.productUnits !== undefined) company.productUnits = cleanProductUnits(body.productUnits);
  await company.save();
  return company;
}

/** A step's priority: 'medium' when none is given. */
export function stepPriority(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_STEP_PRIORITY;
  if (!STEP_PRIORITIES.includes(value)) throw badRequest('Invalid step priority');
  return value;
}

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

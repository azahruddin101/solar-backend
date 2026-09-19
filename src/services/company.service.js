// Companies: the super admin's management operations and the company's own profile.
import { DEFAULT_PANELS, DEFAULT_PILLARS, ROLES } from '../constants/index.js';
import { Client, Company, Design, Panel, Pillar, User } from '../models/index.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import { hashPassword } from '../utils/password.js';
import { pick } from '../utils/pick.js';
import { cleanRichText } from '../utils/richText.js';
import { signToken } from '../utils/token.js';
import { email as validEmail, objectId, password as validPassword } from '../utils/validators.js';
import { deleteCompanyAssets } from './asset.service.js';

const PROFILE = ['name', 'email', 'phone', 'address', 'website', 'taxId'];
const ADMIN_CONTROLS = ['status', 'plan', 'notes'];
const SELF_EDITABLE = [...PROFILE, 'signatoryName', 'signatoryTitle', 'qrLabel', 'tagline', 'pdfTerms', 'currency', 'tariff', 'otherCostPerKw'];

function applyAdminFields(company, body) {
  Object.assign(company, pick(body, [...PROFILE, ...ADMIN_CONTROLS]));
  if (body?.limits) Object.assign(company.limits, pick(body.limits, ['maxClients', 'maxDesigns']));
  if (body?.features) Object.assign(company.features, pick(body.features, ['pdfBranding', 'excelImport']));
}

const countByCompany = async (Model) => new Map((await Model.aggregate([{ $group: { _id: '$company', n: { $sum: 1 } } }])).map((r) => [String(r._id), r.n]));

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
    countByCompany(Panel),
  ]);
  const login = new Map(users.map((u) => [String(u.company), u]));
  return companies.map((c) => ({
    ...c.toJSON(),
    loginEmail: login.get(c.id)?.email || '',
    contactName: login.get(c.id)?.name || '',
    lastLoginAt: login.get(c.id)?.lastLoginAt || null,
    counts: { clients: clients.get(c.id) || 0, designs: designs.get(c.id) || 0, panels: panels.get(c.id) || 0 },
  }));
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
  await company.save();
  try {
    await User.create({ email: loginEmail, passwordHash: await hashPassword(plain), role: ROLES.COMPANY, name: body.contactName || '', company: company._id });
  } catch (e) {
    await company.deleteOne();
    throw e;
  }
  await Panel.insertMany(DEFAULT_PANELS.map((p) => ({ ...p, company: company._id })));
  await Pillar.insertMany(DEFAULT_PILLARS.map((p) => ({ ...p, company: company._id })));
  return describe(company);
}

export async function updateCompanyAsAdmin(id, body) {
  const company = await getOrFail(id);
  applyAdminFields(company, body);
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
  await user.save();
}

/** Open the company's workspace as them (short-lived token, flagged as impersonation). */
export async function impersonate(id, admin) {
  const company = await getOrFail(id);
  if (company.status !== 'active') throw badRequest('Activate the company before signing in as it');
  const user = await loginOf(company._id);
  if (!user) throw notFound('Company login');
  return { token: signToken(user, admin.id), user, company, impersonated: true };
}

export async function deleteCompany(id) {
  const company = await getOrFail(id);
  const filter = { company: company._id };
  await Promise.all([Design.deleteMany(filter), Client.deleteMany(filter), Panel.deleteMany(filter), Pillar.deleteMany(filter), User.deleteMany(filter)]);
  await company.deleteOne();
  await deleteCompanyAssets(company.id);
}

/** A company editing itself: profile, branding text, theme and pricing — never status, plan or limits. */
export async function updateOwnCompany(company, body) {
  Object.assign(company, pick(body, SELF_EDITABLE));
  if (body?.pdfTerms !== undefined) company.pdfTerms = cleanRichText(body.pdfTerms);
  if (body?.theme) Object.assign(company.theme, pick(body.theme, ['primary', 'accent']));
  await company.save();
  return company;
}

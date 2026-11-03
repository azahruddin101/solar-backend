import crypto from 'node:crypto';
import { ROLES, TENANT_ROLES } from '../constants/index.js';
import { AuthSession, Company, Organization, User } from '../models/index.js';
import { managesMasters, orgHasBranches } from '../constants/tenant.js';
import { HttpError, badRequest, forbidden, notFound, unauthorized } from '../utils/HttpError.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { pick } from '../utils/pick.js';
import { signToken } from '../utils/token.js';
import { objectId, password as validPassword } from '../utils/validators.js';
import { assertAdminLoginAllowed, assertConcurrentLoginAllowed, confirmAdminWithinLimit, confirmWithinDeviceLimit, newSessionId, registerSession, revokeAllCompanySessions, revokeSession, revokeUserSessions } from './session.service.js';
import { ownerCompanyView } from '../utils/companyView.js';
import { resolvePermissions } from './permission.service.js';
import { applyOrganizationMasters, branchWithMasters, loadOrganizationForBranch } from './tenant.service.js';

const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const MAX_TRACKED = 20000;
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (now - a.first >= WINDOW) attempts.delete(k);
}, 5 * 60 * 1000).unref();

let dummyHash;
const dummyVerify = async (password) => verifyPassword(password, (dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex'))));

function checkThrottle(key) {
  const a = attempts.get(key);
  if (!a) return;
  if (Date.now() - a.first >= WINDOW) attempts.delete(key);
  else if (a.count >= MAX_FAILURES) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
}
function recordFailure(key) {
  const a = attempts.get(key) || { count: 0, first: Date.now() };
  a.count++;
  attempts.set(key, a);
  if (attempts.size > MAX_TRACKED) attempts.delete(attempts.keys().next().value);
}

export async function userView(user) {
  if (!user) return null;
  const json = user.toJSON ? user.toJSON() : { ...user };
  if (user.role === ROLES.COMPANY || user.role === ROLES.BRANCH) {
    // the owner of a company without branches also edits the masters (there is no company admin above them)
    const org = user.role === ROLES.BRANCH && user.organization ? await Organization.findById(user.organization).select('hasBranches limits').lean() : null;
    return { ...json, managesMasters: managesMasters(user, org), editsCatalog: user.role === ROLES.COMPANY || !orgHasBranches(org) };
  }
  if (user.role !== ROLES.AGENT) return json;
  // the product catalog is shared by the company's branches: with branches, only the company admin changes it
  const org = user.organization ? await Organization.findById(user.organization).select('hasBranches').lean() : null;
  return { ...json, permissions: user.effectivePermissions ?? (await resolvePermissions(user)), editsCatalog: !orgHasBranches(org) };
}

export async function organizationView(user, organization) {
  if (!organization) return null;
  const json = organization.toJSON ? organization.toJSON() : { ...organization };
  return { ...pick(json, ['id', 'name', 'email', 'phone', 'status', 'limits', 'subscription', 'features', 'theme', 'logo']), hasBranches: orgHasBranches(organization) };
}

export async function companyView(user, company) {
  if (!company) return null;
  const merged = await branchWithMasters(company);
  const payload = await ownerCompanyView(merged);
  if (user.role === ROLES.AGENT) return pick(payload, ['id', 'name', 'email', 'phone', 'logo', 'theme', 'currency', 'tariff', 'otherCostPerKw', 'productUnits', 'expenseReasons', 'features']);
  if (user.role === ROLES.CLIENT) return pick(payload, ['id', 'name', 'email', 'phone', 'address', 'website', 'taxId', 'logo', 'signature', 'qr', 'qrLabel', 'tagline', 'signatoryName', 'signatoryTitle', 'theme', 'currency', 'pdfTerms', 'features']);
  return payload;
}

async function resolveLoginBranch(user) {
  if (user.role === ROLES.COMPANY) {
    // the company admin works in their last branch - or, if that one is suspended or gone, the first active one:
    // suspending a branch must never lock the admin out of the rest of the company
    const last = user.company ? await Company.findById(user.company) : null;
    if (last && last.status === 'active' && String(last.organization) === String(user.organization)) return last;
    return (await Company.findOne({ organization: user.organization, status: 'active' }).sort({ createdAt: 1 })) || last;
  }
  return Company.findById(user.company);
}

export async function login({ email, password, ip, userAgent, replaceSessions = false }) {
  email = String(email ?? '').trim().toLowerCase();
  password = String(password ?? '');
  if (!email || !password) throw badRequest('Email and password are required');
  const key = `${ip}|${email}`;
  checkThrottle(key);

  const user = await User.findOne({ email });
  const passwordOk = user ? await verifyPassword(password, user.passwordHash) : (await dummyVerify(password), false);
  if (!passwordOk) {
    recordFailure(key);
    throw unauthorized('Incorrect email or password');
  }
  if ((user.role === ROLES.AGENT || user.role === ROLES.CLIENT) && !user.active) throw forbidden('This account has been deactivated. Contact your company.');
  let company = null;
  let organization = null;
  if (TENANT_ROLES.includes(user.role)) {
    company = await resolveLoginBranch(user);
    if (!company) throw unauthorized('Incorrect email or password');
    if (company.status !== 'active') throw forbidden('This company account is suspended. Contact the platform administrator.');
    organization = await loadOrganizationForBranch(company);
    if (organization?.status && organization.status !== 'active') throw forbidden('This company account is suspended. Contact the platform administrator.');
    if (user.role === ROLES.COMPANY && !orgHasBranches(organization)) throw unauthorized('Incorrect email or password');
    applyOrganizationMasters(company, organization);
  }
  attempts.delete(key);
  let token;
  if (company) {
    if (user.role === ROLES.BRANCH) {
      if (replaceSessions) await revokeAllCompanySessions(company._id);
      else await assertConcurrentLoginAllowed(company);
    } else if (user.role === ROLES.COMPANY) {
      if (replaceSessions) await revokeUserSessions(user._id); // only the admin's own devices
      else await assertAdminLoginAllowed(user, organization);
    }
    const sid = newSessionId();
    await registerSession({ user, company, sessionId: sid, userAgent });
    if (user.role === ROLES.BRANCH && !replaceSessions) await confirmWithinDeviceLimit(company, sid);
    if (user.role === ROLES.COMPANY && !replaceSessions) await confirmAdminWithinLimit(user, organization, sid);
    token = signToken(user, { sid, branchId: company._id });
  } else {
    const sid = newSessionId();
    await registerSession({ user, sessionId: sid, userAgent });
    token = signToken(user, { sid });
  }
  user.lastLoginAt = new Date();
  await user.save();
  return {
    token,
    user: await userView(user),
    company: await companyView(user, company),
    organization: await organizationView(user, organization),
    impersonated: false,
  };
}

/** Super admin opens a tenant workspace as the company admin or a branch owner. */
export async function impersonationSession(user, admin, { hintBranch } = {}) {
  if (!user) throw notFound('User');
  let company = hintBranch;
  let organization = null;
  if (TENANT_ROLES.includes(user.role)) {
    if (user.role === ROLES.COMPANY) company = await resolveLoginBranch(user);
    else if (!company) company = await Company.findById(user.company);
    if (!company || company.status !== 'active') throw badRequest('Activate the company before signing in as it');
    organization = await loadOrganizationForBranch(company);
    if (organization?.status && organization.status !== 'active') throw forbidden('This company account is suspended.');
    applyOrganizationMasters(company, organization);
  }
  const sid = newSessionId();
  await registerSession({ user: admin, sessionId: sid, userAgent: 'impersonation', impersonation: true });
  user.lastLoginAt = new Date();
  await user.save();
  return {
    token: signToken(user, { by: admin.id, sid, branchId: company?._id }),
    user: await userView(user),
    company: await companyView(user, company),
    organization: await organizationView(user, organization),
    impersonated: true,
  };
}

export async function switchBranch(user, branchId, sessionId) {
  if (user.role !== ROLES.COMPANY) throw forbidden();
  const id = objectId(branchId, 'Branch');
  const branch = await Company.findOne({ _id: id, organization: user.organization, status: 'active' });
  if (!branch) throw notFound('Branch');
  user.company = branch._id;
  await user.save();
  if (sessionId) await AuthSession.updateOne({ sessionId }, { $set: { company: branch._id } });
  const organization = await loadOrganizationForBranch(branch);
  applyOrganizationMasters(branch, organization);
  const token = signToken(user, { sid: sessionId, branchId: branch._id });
  return { token, user: await userView(user), company: await companyView(user, branch), organization: await organizationView(user, organization) };
}

export async function logout(sessionId) {
  await revokeSession(sessionId);
}

export async function updateProfile(user, { name }) {
  if (typeof name === 'string') user.name = name;
  await user.save();
  return user;
}

export async function changePassword(user, { current, next }, sessionId = null) {
  if (!(await verifyPassword(String(current ?? ''), user.passwordHash))) throw badRequest('Current password is incorrect');
  user.passwordHash = await hashPassword(validPassword(next));
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  await revokeUserSessions(user._id);
  const sid = newSessionId();
  const company = user.company ? await Company.findById(user.company) : null;
  await registerSession({ user, company, sessionId: sid });
  return { token: signToken(user, { sid, branchId: company?._id }) };
}

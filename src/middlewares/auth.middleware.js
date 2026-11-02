import { PERMISSION_CATALOG, ROLES, TENANT_ROLES } from '../constants/index.js';
import { hasBranchOwnerAccess, managesMasters, orgHasBranches } from '../constants/tenant.js';
import { Company, Organization, User } from '../models/index.js';
import { forbidden, unauthorized } from '../utils/HttpError.js';
import { verifyMapToken, verifyToken } from '../utils/token.js';
import { attachPermissions } from '../services/permission.service.js';
import { applyOrganizationMasters, loadOrganizationForBranch } from '../services/tenant.service.js';
import { validateSession } from '../services/session.service.js';

async function resolveBranchId(user, claims) {
  if (user.role === ROLES.COMPANY) {
    if (claims.bid) return claims.bid;
    if (user.company) return user.company;
    const first = await Company.findOne({ organization: user.organization, status: 'active' }).select('_id').sort({ createdAt: 1 }).lean();
    return first?._id || null;
  }
  return user.company;
}

/** Loads the user (and company) named by verified token claims and applies every revocation check. */
async function loadFromClaims(req, claims) {
  const user = await User.findById(claims.sub);
  if (!user) throw unauthorized('Account no longer exists');
  if ((claims.tv ?? 0) !== (user.tokenVersion || 0)) throw unauthorized('Your password was changed. Sign in again.');
  req.user = user;
  req.sessionId = claims.sid || null;
  req.impersonatedBy = claims.by || null;
  if (claims.by) {
    const admin = await User.findById(claims.by).select('role');
    if (admin?.role !== ROLES.SUPERADMIN) throw unauthorized('This admin session is no longer valid.');
    if (claims.sid && !(await validateSession(claims.sid))) throw unauthorized('This admin session has ended.');
  } else if (TENANT_ROLES.includes(user.role)) {
    if (!claims.sid) throw unauthorized('Your session is outdated. Sign in again on this device.');
    const ok = await validateSession(claims.sid);
    if (!ok) throw unauthorized('This device was signed out. Sign in again, or free a slot by signing out on another device.');
  } else if (claims.sid && !(await validateSession(claims.sid))) {
    throw unauthorized('You were signed out. Sign in again.');
  }
  if ((user.role === ROLES.AGENT || user.role === ROLES.CLIENT) && !user.active) throw unauthorized('This account has been deactivated');

  if (TENANT_ROLES.includes(user.role)) {
    const branchId = await resolveBranchId(user, claims);
    if (!branchId) throw unauthorized('No branch is available for this account.');
    // the organization is loaded just below and its shared settings applied here, so skip the model's own overlay
    let company = await Company.findById(branchId).setOptions({ rawBranch: true });
    // the company admin's branch was suspended or deleted: carry on in an active branch of the same company
    if (user.role === ROLES.COMPANY && (!company || company.status !== 'active')) {
      company = (await Company.findOne({ organization: user.organization, status: 'active' }).sort({ createdAt: 1 }).setOptions({ rawBranch: true })) || company;
    }
    if (!company) throw unauthorized('Company no longer exists');
    if (company.status !== 'active') throw forbidden('This company account is suspended. Contact the platform administrator.');
    if (user.organization && company.organization && String(user.organization) !== String(company.organization)) throw forbidden();
    if (user.role === ROLES.COMPANY && String(company.organization) !== String(user.organization)) throw forbidden();
    req.organization = company.organization ? await Organization.findById(company.organization) : null;
    if (req.organization?.status && req.organization.status !== 'active') throw forbidden('This company account is suspended. Contact the platform administrator.');
    // a company admin only exists above branches: never in a company set up without them
    if (user.role === ROLES.COMPANY && !orgHasBranches(req.organization)) throw unauthorized('This sign-in is no longer valid.');
    applyOrganizationMasters(company, req.organization);
    req.company = company;
    req.branchId = company._id;
  }
  if (user.role === ROLES.AGENT) await attachPermissions(user);
}

export async function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw unauthorized();
  let claims;
  try {
    claims = verifyToken(token);
  } catch {
    throw unauthorized('Your session has expired. Sign in again.');
  }
  await loadFromClaims(req, claims);
  next();
}

export async function authenticateMapAccess(req, res, next) {
  if (req.get('authorization')) return authenticate(req, res, next);
  const claims = typeof req.query.mt === 'string' ? verifyMapToken(req.query.mt) : null;
  if (!claims) throw unauthorized('This image link has expired. Reload the page.');
  await loadFromClaims(req, claims);
  next();
}

const gate = (fn, describe) => Object.assign(fn, { authorizes: describe });

export const requireRole = (...roles) => gate((req, res, next) => {
  if (!roles.includes(req.user?.role)) throw forbidden();
  next();
}, `role:${roles.join('|')}`);

export const superAdminOnly = [authenticate, requireRole(ROLES.SUPERADMIN)];
/** Branch workspace (owner or org admin in branch context). */
export const branchOnly = [authenticate, requireRole(ROLES.BRANCH, ROLES.COMPANY)];
/** @deprecated use branchOnly */
export const companyOnly = branchOnly;
export const organizationOnly = [authenticate, requireRole(ROLES.COMPANY)];
/** Editing the shared masters: the company admin, or the owner of a company without branches. */
export const mastersOnly = [authenticate, gate((req, res, next) => {
  if (!managesMasters(req.user, req.organization)) throw forbidden('Only your company admin can change these settings.');
  next();
}, 'masters')];
export const agentOnly = [authenticate, requireRole(ROLES.AGENT)];
export const clientOnly = [authenticate, requireRole(ROLES.CLIENT)];

const permissionsOf = (user) => user?.effectivePermissions ?? user?.permissions ?? [];

export const hasPermission = (user, area, action) => hasBranchOwnerAccess(user) || (user?.role === ROLES.AGENT && permissionsOf(user).includes(`${area}:${action}`));

export const hasAreaAccess = (user, area) => hasBranchOwnerAccess(user) || (user?.role === ROLES.AGENT && Object.keys(PERMISSION_CATALOG[area]?.actions || {}).some((a) => permissionsOf(user).includes(`${area}:${a}`)));

export const hasAnyAreaAccess = (user, ...areas) => areas.some((a) => hasAreaAccess(user, a));

function assertPermission(area, action) {
  if (!PERMISSION_CATALOG[area]) throw new Error(`Unknown permission area "${area}"`);
  if (action !== undefined && !PERMISSION_CATALOG[area].actions[action]) throw new Error(`Unknown permission "${area}:${action}"`);
}

const missing = (pairs) => forbidden(`You need the ${pairs.map(([area, action]) => `“${PERMISSION_CATALOG[area].label} › ${PERMISSION_CATALOG[area].actions[action]}”`).join(' or ')} permission. Ask your company admin.`);

export const permissionOnly = (area, ...actions) => {
  if (!actions.length) throw new Error(`permissionOnly('${area}') needs an action`);
  actions.forEach((action) => assertPermission(area, action));
  return gate((req, res, next) => {
    if (!actions.some((action) => hasPermission(req.user, area, action))) throw missing(actions.map((action) => [area, action]));
    next();
  }, `permission:${area}:${actions.join('|')}`);
};

export const permissionOnlyAny = (areas, action) => {
  areas.forEach((area) => assertPermission(area, action));
  return gate((req, res, next) => {
    if (!areas.some((area) => hasPermission(req.user, area, action))) throw missing(areas.map((area) => [area, action]));
    next();
  }, `permission:${areas.join('|')}:${action}`);
};

export const withPermission = (area, action) => [authenticate, permissionOnly(area, action)];

export const withAreaAccess = (...areas) => {
  areas.forEach((area) => assertPermission(area));
  const areaCheck = (req, res, next) => {
    if (!hasAnyAreaAccess(req.user, ...areas)) throw forbidden(`You don't have access to ${areas.map((a) => PERMISSION_CATALOG[a].label).join(' or ')}. Ask your company admin.`);
    next();
  };
  return [authenticate, Object.assign(areaCheck, { areaCheck: areas })];
};

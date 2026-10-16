import { PERMISSION_CATALOG, ROLES, TENANT_ROLES } from '../constants/index.js';
import { Company, User } from '../models/index.js';
import { forbidden, unauthorized } from '../utils/HttpError.js';
import { verifyMapToken, verifyToken } from '../utils/token.js';
import { attachPermissions } from '../services/permission.service.js';
import { validateSession } from '../services/session.service.js';

/** Loads the user (and company) named by verified token claims and applies every revocation check. */
async function loadFromClaims(req, claims) {
  const user = await User.findById(claims.sub);
  if (!user) throw unauthorized('Account no longer exists');
  // a password change/reset bumps tokenVersion; tokens issued before it are dead (tokens from before this claim existed count as 0)
  if ((claims.tv ?? 0) !== (user.tokenVersion || 0)) throw unauthorized('Your password was changed. Sign in again.');
  req.user = user;
  req.sessionId = claims.sid || null;
  req.impersonatedBy = claims.by || null;
  if (claims.by) {
    // an admin signed in as a company: the admin must still be a super admin, and the impersonation itself can be ended
    const admin = await User.findById(claims.by).select('role');
    if (admin?.role !== ROLES.SUPERADMIN) throw unauthorized('This admin session is no longer valid.');
    if (claims.sid && !(await validateSession(claims.sid))) throw unauthorized('This admin session has ended.');
  } else if (TENANT_ROLES.includes(user.role)) {
    if (!claims.sid) throw unauthorized('Your session is outdated. Sign in again on this device.');
    const ok = await validateSession(claims.sid);
    if (!ok) throw unauthorized('This device was signed out. Sign in again, or free a slot by signing out on another device.');
  } else if (claims.sid && !(await validateSession(claims.sid))) {
    // super admin: tokens carry a session id too, so logging out really ends them (older tokens without one still work until they expire)
    throw unauthorized('You were signed out. Sign in again.');
  }
  if ((user.role === ROLES.AGENT || user.role === ROLES.CLIENT) && !user.active) throw unauthorized('This account has been deactivated');
  if (TENANT_ROLES.includes(user.role)) {
    const company = await Company.findById(user.company);
    if (!company) throw unauthorized('Company no longer exists');
    if (company.status !== 'active') throw forbidden('This company account is suspended. Contact the platform administrator.');
    req.company = company;
  }
  // staff: the permissions of their roles plus their own extra grants, fresh from the database on every request
  if (user.role === ROLES.AGENT) await attachPermissions(user);
}

/** Authorization: Bearer <token> only. (A token in the URL would end up in logs and history, so it is not accepted.) */
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

/**
 * For the satellite-image route only: <img> and WebGL texture requests cannot send an Authorization header, so they
 * carry ?mt= — a 15-minute, single-purpose token (not a login token) obtained from GET /api/staticmap/token.
 */
export async function authenticateMapAccess(req, res, next) {
  if (req.get('authorization')) return authenticate(req, res, next);
  const claims = typeof req.query.mt === 'string' ? verifyMapToken(req.query.mt) : null;
  if (!claims) throw unauthorized('This image link has expired. Reload the page.');
  await loadFromClaims(req, claims);
  next();
}

/** Marks a middleware as an authorization gate (tests/routeAccess.test.js checks every route has one). */
const gate = (fn, describe) => Object.assign(fn, { authorizes: describe });

export const requireRole = (...roles) => gate((req, res, next) => {
  if (!roles.includes(req.user?.role)) throw forbidden();
  next();
}, `role:${roles.join('|')}`);

export const superAdminOnly = [authenticate, requireRole(ROLES.SUPERADMIN)];
export const companyOnly = [authenticate, requireRole(ROLES.COMPANY)];
export const agentOnly = [authenticate, requireRole(ROLES.AGENT)];
export const clientOnly = [authenticate, requireRole(ROLES.CLIENT)];

/** A staff member's effective permissions (attached by `authenticate`; their own direct grants otherwise). */
const permissionsOf = (user) => user?.effectivePermissions ?? user?.permissions ?? [];

/**
 * True for the company owner, or a staff (agent) account holding `<area>:<action>` through one of its roles or an
 * extra grant (e.g. `hasPermission(user, 'finances', 'create_receipt')`). See constants/permissions.js.
 */
export const hasPermission = (user, area, action) => user?.role === ROLES.COMPANY || (user?.role === ROLES.AGENT && permissionsOf(user).includes(`${area}:${action}`));

/** True for the company owner, or a staff account granted at least one action within this area. */
export const hasAreaAccess = (user, area) => user?.role === ROLES.COMPANY || (user?.role === ROLES.AGENT && Object.keys(PERMISSION_CATALOG[area]?.actions || {}).some((a) => permissionsOf(user).includes(`${area}:${a}`)));

/** True for the company owner, or a staff account granted at least one action across any of these areas. */
export const hasAnyAreaAccess = (user, ...areas) => areas.some((a) => hasAreaAccess(user, a));

/** Throws at startup when a route names a permission that doesn't exist, so a typo can't silently lock a route. */
function assertPermission(area, action) {
  if (!PERMISSION_CATALOG[area]) throw new Error(`Unknown permission area "${area}"`);
  if (action !== undefined && !PERMISSION_CATALOG[area].actions[action]) throw new Error(`Unknown permission "${area}:${action}"`);
}

/** "You need the Finances › Record payment permission" — what a refused staff member is told. */
const missing = (pairs) => forbidden(`You need the ${pairs.map(([area, action]) => `“${PERMISSION_CATALOG[area].label} › ${PERMISSION_CATALOG[area].actions[action]}”`).join(' or ')} permission. Ask your company admin.`);

/**
 * Bare middleware (assumes `authenticate` already ran) for gating one route within an already-mounted router.
 * With several actions, any one of them is enough: `permissionOnly('clients', 'create', 'update')`.
 */
export const permissionOnly = (area, ...actions) => {
  if (!actions.length) throw new Error(`permissionOnly('${area}') needs an action`);
  actions.forEach((action) => assertPermission(area, action));
  return gate((req, res, next) => {
    if (!actions.some((action) => hasPermission(req.user, area, action))) throw missing(actions.map((action) => [area, action]));
    next();
  }, `permission:${area}:${actions.join('|')}`);
};

/** Like `permissionOnly`, but passes if the user has `action` in ANY of these areas (e.g. a product is readable by 'proposals:view' or 'inventory:view'). */
export const permissionOnlyAny = (areas, action) => {
  areas.forEach((area) => assertPermission(area, action));
  return gate((req, res, next) => {
    if (!areas.some((area) => hasPermission(req.user, area, action))) throw missing(areas.map((area) => [area, action]));
    next();
  }, `permission:${areas.join('|')}:${action}`);
};

/** A company workspace area, one specific action: the owner always gets in; a staff account needs that exact permission. */
export const withPermission = (area, action) => [authenticate, permissionOnly(area, action)];

/**
 * Mount-level gate for a whole area's router: lets in anyone with at least one action granted in this area — the
 * router's own routes then check the exact action each needs (see e.g. design.routes.js).
 */
export const withAreaAccess = (...areas) => {
  areas.forEach((area) => assertPermission(area));
  return [
    authenticate,
    (req, res, next) => {
      if (!hasAnyAreaAccess(req.user, ...areas)) throw forbidden(`You don't have access to ${areas.map((a) => PERMISSION_CATALOG[a].label).join(' or ')}. Ask your company admin.`);
      next();
    },
  ];
};

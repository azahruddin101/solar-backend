import { ROLES, STAFF_PERMISSION_ACTIONS, TENANT_ROLES } from '../constants/index.js';
import { Company, User } from '../models/index.js';
import { forbidden, unauthorized } from '../utils/HttpError.js';
import { verifyMapToken, verifyToken } from '../utils/token.js';
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

export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) throw forbidden();
  next();
};

export const superAdminOnly = [authenticate, requireRole(ROLES.SUPERADMIN)];
export const companyOnly = [authenticate, requireRole(ROLES.COMPANY)];
export const agentOnly = [authenticate, requireRole(ROLES.AGENT)];
export const clientOnly = [authenticate, requireRole(ROLES.CLIENT)];

/**
 * True for the company owner, or a staff (agent) account the company granted `<area>:<action>` to
 * (e.g. `hasPermission(user, 'designs', 'create')`). CRUD-level: a staff account can be given any
 * combination of view/create/update/delete within an area, independently.
 */
export const hasPermission = (user, area, action) => user?.role === ROLES.COMPANY || (user?.role === ROLES.AGENT && user.permissions?.includes(`${area}:${action}`));

/** True for the company owner, or a staff account granted at least one action within this area. */
export const hasAreaAccess = (user, area) => user?.role === ROLES.COMPANY || (user?.role === ROLES.AGENT && STAFF_PERMISSION_ACTIONS.some((a) => user.permissions?.includes(`${area}:${a}`)));

/** True for the company owner, or a staff account granted at least one action across any of these areas. */
export const hasAnyAreaAccess = (user, ...areas) => areas.some((a) => hasAreaAccess(user, a));

/** Bare middleware (assumes `authenticate` already ran) for gating one route within an already-mounted router. */
export const permissionOnly = (area, action) => (req, res, next) => {
  if (!hasPermission(req.user, area, action)) throw forbidden();
  next();
};

/** Like `permissionOnly`, but passes if the user has `action` in ANY of these areas (e.g. a product is readable by 'designs:view' or 'catalog:view'). */
export const permissionOnlyAny = (areas, action) => (req, res, next) => {
  if (!areas.some((area) => hasPermission(req.user, area, action))) throw forbidden();
  next();
};

/** A company workspace area, one specific CRUD action: the owner always gets in; a staff account needs that exact permission. */
export const withPermission = (area, action) => [authenticate, permissionOnly(area, action)];

/**
 * Mount-level gate for a whole area's router: lets in anyone with at least one action granted in this
 * area (view/create/update/delete) — the router's own routes then check the exact action each needs
 * (see e.g. design.routes.js). Without this, a "create-only" staff account (no `view`) would never
 * reach the POST route at all.
 */
export const withAreaAccess = (...areas) => [
  authenticate,
  (req, res, next) => {
    if (!hasAnyAreaAccess(req.user, ...areas)) throw forbidden();
    next();
  },
];

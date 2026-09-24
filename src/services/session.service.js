import crypto from 'node:crypto';
import { ROLES } from '../constants/index.js';
import { AuthSession, User } from '../models/index.js';
import { HttpError } from '../utils/HttpError.js';
import { sessionExpiresAt } from '../utils/token.js';
import { effectiveLimitsForCompany } from './subscription.service.js';

export const DEVICE_LIMIT_CODE = 'DEVICE_LIMIT';

export function newSessionId() {
  return crypto.randomUUID();
}

function deviceLabel(userAgent = '') {
  const ua = String(userAgent);
  if (/iPhone|iPad/i.test(ua)) return 'iPhone or iPad';
  if (/Android/i.test(ua)) return 'Android device';
  if (/Macintosh|Mac OS/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux device';
  return ua.slice(0, 60) || 'Unknown device';
}

/**
 * The plan's device limit covers the company's own (owner) sign-ins. Field agents have their own accounts and
 * are exempt: they neither use up nor get blocked by the owner's devices.
 */
async function ownerSessionFilter(companyId) {
  const owners = await User.find({ company: companyId, role: ROLES.COMPANY }).distinct('_id');
  return { company: companyId, user: { $in: owners } };
}

async function purgeExpiredForCompany(companyId) {
  const now = new Date();
  await AuthSession.deleteMany({
    company: companyId,
    $or: [{ expiresAt: { $lte: now } }, { expiresAt: null }, { expiresAt: { $exists: false } }],
  });
}

export async function listActiveCompanySessions(companyId) {
  await purgeExpiredForCompany(companyId);
  const rows = await AuthSession.find({ ...(await ownerSessionFilter(companyId)), expiresAt: { $gt: new Date() } })
    .sort({ lastActiveAt: -1 })
    .populate('user', 'name email role')
    .limit(20);
  return rows.map((s) => ({
    sessionId: s.sessionId,
    userName: s.user?.name || s.user?.email || 'User',
    userEmail: s.user?.email || '',
    role: s.user?.role || '',
    device: deviceLabel(s.userAgent),
    lastActiveAt: s.lastActiveAt,
  }));
}

/** `company` is null for platform-admin sessions and for an admin's impersonation of a company (2 hours). */
export async function registerSession({ user, company = null, sessionId, userAgent, impersonation = false }) {
  await AuthSession.create({
    user: user._id,
    company: company?._id || null,
    sessionId,
    userAgent: userAgent?.slice(0, 300) || '',
    lastActiveAt: new Date(),
    expiresAt: sessionExpiresAt({ impersonation }),
  });
}

/** Sign one user out everywhere (used when their password changes or is reset). */
export async function revokeUserSessions(userId) {
  await AuthSession.deleteMany({ user: userId });
}

/** Returns false if the session id is unknown or expired. */
export async function validateSession(sessionId) {
  if (!sessionId) return false;
  const row = await AuthSession.findOneAndUpdate(
    { sessionId, expiresAt: { $gt: new Date() } },
    { $set: { lastActiveAt: new Date() } },
  );
  return Boolean(row);
}

export async function revokeSession(sessionId) {
  if (!sessionId) return;
  await AuthSession.deleteOne({ sessionId });
}

/** Sign out every device for this company (used after password check on the sign-in page). */
export async function revokeAllCompanySessions(companyId) {
  await AuthSession.deleteMany(await ownerSessionFilter(companyId));
}

/**
 * Call right after registering an owner's session: two sign-ins can pass assertConcurrentLoginAllowed together, so
 * re-count and, if the plan's device limit was passed, remove this session and refuse it.
 */
export async function confirmWithinDeviceLimit(company, sessionId) {
  const max = Math.max(1, (await effectiveLimitsForCompany(company)).maxConcurrentLogins || 1);
  const active = await AuthSession.countDocuments({ ...(await ownerSessionFilter(company._id)), expiresAt: { $gt: new Date() } });
  if (active > max) {
    await AuthSession.deleteOne({ sessionId });
    throw new HttpError(403, `Your plan allows ${max} device${max === 1 ? '' : 's'} signed in at once. Sign out on another device first.`, DEVICE_LIMIT_CODE, { max, active: active - 1, sessions: await listActiveCompanySessions(company._id) });
  }
}

export async function assertConcurrentLoginAllowed(company) {
  const limits = await effectiveLimitsForCompany(company);
  const max = Math.max(1, limits.maxConcurrentLogins || 1);
  await purgeExpiredForCompany(company._id);
  const active = await AuthSession.countDocuments({ ...(await ownerSessionFilter(company._id)), expiresAt: { $gt: new Date() } });
  if (active >= max) {
    const sessions = await listActiveCompanySessions(company._id);
    throw new HttpError(
      403,
      max === 1
        ? 'Another device is already signed in. Sign out there first, then try again.'
        : `Your plan allows ${max} devices signed in at once. Sign out on another device first.`,
      DEVICE_LIMIT_CODE,
      { max, active, sessions },
    );
  }
}

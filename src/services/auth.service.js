import crypto from 'node:crypto';
import { ROLES, TENANT_ROLES } from '../constants/index.js';
import { Company, User } from '../models/index.js';
import { HttpError, badRequest, forbidden, unauthorized } from '../utils/HttpError.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { pick } from '../utils/pick.js';
import { signToken } from '../utils/token.js';
import { password as validPassword } from '../utils/validators.js';
import { assertConcurrentLoginAllowed, confirmWithinDeviceLimit, newSessionId, registerSession, revokeAllCompanySessions, revokeSession, revokeUserSessions } from './session.service.js';
import { ownerCompanyView } from '../utils/companyView.js';

// Tiny in-memory throttle for sign-in: 8 failures per 15 min per ip+email.
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_FAILURES = 8;

// expired entries are swept regularly and the table is capped, so junk emails cannot grow it without bound
const MAX_TRACKED = 20000;
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (now - a.first >= WINDOW) attempts.delete(k);
}, 5 * 60 * 1000).unref();

// verifying against this when the email is unknown keeps the response time the same as for a wrong password
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
  if (attempts.size > MAX_TRACKED) attempts.delete(attempts.keys().next().value); // oldest first
}

/** What a signed-in user may see of their company: agents only get its name, contact and branding. */
export async function companyView(user, company) {
  if (!company) return null;
  const payload = await ownerCompanyView(company);
  if (user.role === ROLES.AGENT) return pick(payload, ['id', 'name', 'email', 'phone', 'logo', 'theme']);
  return payload;
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
  if (user.role === ROLES.AGENT && !user.active) throw forbidden('This account has been deactivated. Contact your company.');
  let company = null;
  if (TENANT_ROLES.includes(user.role)) {
    company = await Company.findById(user.company);
    if (!company) throw unauthorized('Incorrect email or password');
    if (company.status !== 'active') throw forbidden('This company account is suspended. Contact the platform administrator.');
  }
  attempts.delete(key);
  let token;
  if (company) {
    if (user.role === ROLES.COMPANY) {
      if (replaceSessions) await revokeAllCompanySessions(company._id);
      else await assertConcurrentLoginAllowed(company);
    }
    const sid = newSessionId();
    await registerSession({ user, company, sessionId: sid, userAgent });
    if (user.role === ROLES.COMPANY && !replaceSessions) await confirmWithinDeviceLimit(company, sid);
    token = signToken(user, { sid });
  } else {
    const sid = newSessionId();
    await registerSession({ user, sessionId: sid, userAgent });
    token = signToken(user, { sid });
  }
  user.lastLoginAt = new Date();
  await user.save();
  return { token, user, company: await companyView(user, company), impersonated: false };
}

export async function logout(sessionId) {
  await revokeSession(sessionId);
}

export async function updateProfile(user, { name }) {
  if (typeof name === 'string') user.name = name;
  await user.save();
  return user;
}

/** Changes the password, signs the account out everywhere else, and returns a fresh token for the caller's own session. */
export async function changePassword(user, { current, next }, sessionId = null) {
  if (!(await verifyPassword(String(current ?? ''), user.passwordHash))) throw badRequest('Current password is incorrect');
  user.passwordHash = await hashPassword(validPassword(next));
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  await revokeUserSessions(user._id);
  const sid = newSessionId();
  const company = user.company ? await Company.findById(user.company) : null;
  await registerSession({ user, company, sessionId: sid });
  return { token: signToken(user, { sid }) };
}

import { ROLES } from '../constants/index.js';
import { Company, User } from '../models/index.js';
import { HttpError, badRequest, forbidden, unauthorized } from '../utils/HttpError.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { signToken } from '../utils/token.js';
import { password as validPassword } from '../utils/validators.js';

// Tiny in-memory throttle for sign-in: 8 failures per 15 min per ip+email.
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_FAILURES = 8;

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
}

export async function login({ email, password, ip }) {
  email = String(email ?? '').trim().toLowerCase();
  password = String(password ?? '');
  if (!email || !password) throw badRequest('Email and password are required');
  const key = `${ip}|${email}`;
  checkThrottle(key);

  const user = await User.findOne({ email });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    recordFailure(key);
    throw unauthorized('Incorrect email or password');
  }
  let company = null;
  if (user.role === ROLES.COMPANY) {
    company = await Company.findById(user.company);
    if (!company) throw unauthorized('Incorrect email or password');
    if (company.status !== 'active') throw forbidden('This company account is suspended. Contact the platform administrator.');
  }
  attempts.delete(key);
  user.lastLoginAt = new Date();
  await user.save();
  return { token: signToken(user), user, company, impersonated: false };
}

export async function updateProfile(user, { name }) {
  if (typeof name === 'string') user.name = name;
  await user.save();
  return user;
}

export async function changePassword(user, { current, next }) {
  if (!(await verifyPassword(String(current ?? ''), user.passwordHash))) throw badRequest('Current password is incorrect');
  user.passwordHash = await hashPassword(validPassword(next));
  await user.save();
}

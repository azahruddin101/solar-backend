import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/** `by` is set when a super admin is signed in as a company (impersonation). `sid` tracks device sessions. */
export const signToken = (user, { by = null, sid = null } = {}) =>
  jwt.sign(
    { sub: String(user.id), role: user.role, tv: user.tokenVersion || 0, ...(sid ? { sid: String(sid) } : {}), ...(by ? { by: String(by) } : {}) },
    env.jwtSecret,
    { expiresIn: by ? '2h' : env.jwtExpires },
  );

export const verifyToken = (token) => jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });

/** When a tenant session row should expire (aligned with JWT lifetime). */
export function sessionExpiresAt({ impersonation = false } = {}) {
  const token = jwt.sign({ tmp: 1 }, env.jwtSecret, { expiresIn: impersonation ? '2h' : env.jwtExpires });
  return new Date(jwt.decode(token).exp * 1000);
}

/* ───────────── satellite-image token ───────────── */

const MAP_TTL_MS = 15 * 60 * 1000;
const mapKey = () => crypto.createHash('sha256').update(`map-token:${env.jwtSecret}`).digest();
const mapMac = (body) => crypto.createHmac('sha256', mapKey()).update(body).digest('base64url');

/** Short-lived token that is only good for GET /api/staticmap (it is not a login token and cannot be used elsewhere). */
export function signMapToken({ user, sid = null, by = null }) {
  const body = Buffer.from(JSON.stringify({ sub: String(user.id), tv: user.tokenVersion || 0, ...(sid ? { sid: String(sid) } : {}), ...(by ? { by: String(by) } : {}), exp: Date.now() + MAP_TTL_MS })).toString('base64url');
  return `${body}.${mapMac(body)}`;
}

/** Claims of a valid, unexpired map token; null otherwise. */
export function verifyMapToken(token) {
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(mapMac(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    return claims.exp > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

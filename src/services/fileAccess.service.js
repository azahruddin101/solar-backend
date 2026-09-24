// Who may open which uploaded file. Branding images and avatars are public (the PDF generator and every screen
// load them directly); client documents, installation photos and ticket attachments are protected: they open only
// through a short-lived signed link that a signed-in, authorised user asks the API for.
import crypto from 'node:crypto';
import path from 'node:path';
import { env } from '../config/env.js';
import { ROLES } from '../constants/index.js';
import { Ticket } from '../models/index.js';
import { forbidden, notFound } from '../utils/HttpError.js';

export const SAFE_NAME = /^[\w][\w.-]{0,200}$/;
export const LINK_TTL_MS = 10 * 60 * 1000;

const DOC = /^[0-9a-f]{24}-doc-/; // client documents:   <companyId>-doc-…
const STEP = /^[0-9a-f]{24}-step-/; // installation photos: <companyId>-step-…
const TICKET = /^ticket-/; // support attachments: ticket-…

export const isProtected = (name) => DOC.test(name) || STEP.test(name) || TICKET.test(name);

const key = () => crypto.createHash('sha256').update(`file-link:${env.jwtSecret}`).digest();
const mac = (name, exp) => crypto.createHmac('sha256', key()).update(`${name}.${exp}`).digest('hex');

export function signName(name, now = Date.now()) {
  const exp = now + LINK_TTL_MS;
  return { exp, sig: mac(name, exp) };
}

/** True when `sig` is the signature for this file and `exp` has not passed. */
export function validSignature(name, exp, sig, now = Date.now()) {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < now || typeof sig !== 'string') return false;
  const expected = Buffer.from(mac(name, e), 'hex');
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(expected, given);
}

/** Throws unless `user` may open the protected file `name`. */
export async function assertCanOpen(user, name) {
  if (user.role === ROLES.SUPERADMIN) return;
  const owner = name.slice(0, 24);
  if (DOC.test(name)) {
    if (user.role === ROLES.COMPANY && String(user.company) === owner) return;
  } else if (STEP.test(name)) {
    if (String(user.company) === owner) return; // the company's owner and its agents
  } else if (TICKET.test(name)) {
    if (user.role !== ROLES.COMPANY) throw forbidden();
    const ticket = await Ticket.findOne({ company: user.company, 'messages.attachments.url': `/uploads/${name}` }).select('_id').lean();
    if (ticket) return;
  }
  throw forbidden('You do not have access to this file');
}

/** `url` is what the app stores: /uploads/<name>. Returns the same path with an expiry and signature. */
export async function linkFor(user, url) {
  const name = path.basename(String(url ?? ''));
  if (String(url ?? '') !== `/uploads/${name}` || !SAFE_NAME.test(name)) throw notFound('File'); // exactly /uploads/<name>
  if (!isProtected(name)) return { url: `/uploads/${name}` }; // public files need no link
  await assertCanOpen(user, name);
  const { exp, sig } = signName(name);
  return { url: `/uploads/${name}?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp).toISOString() };
}

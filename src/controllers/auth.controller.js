import * as authService from '../services/auth.service.js';
import { forbidden } from '../utils/HttpError.js';

const session = async (req) => ({ user: req.user, company: await authService.companyView(req.user, req.company || null), impersonated: Boolean(req.impersonatedBy) });

export async function login(req, res) {
  res.json(await authService.login({
    email: req.body?.email,
    password: req.body?.password,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    replaceSessions: Boolean(req.body?.replaceSessions),
  }));
}

export async function me(req, res) {
  res.json(await session(req));
}

export async function updateMe(req, res) {
  await authService.updateProfile(req.user, req.body || {});
  res.json(await session(req));
}

export async function logout(req, res) {
  await authService.logout(req.sessionId);
  res.json({ ok: true });
}

export async function changePassword(req, res) {
  if (req.impersonatedBy) throw forbidden('Not available while signed in as a company. Reset it from the admin console.');
  res.json({ ok: true, ...(await authService.changePassword(req.user, req.body || {}, req.sessionId)) });
}

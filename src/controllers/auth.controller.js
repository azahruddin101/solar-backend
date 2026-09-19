import * as authService from '../services/auth.service.js';
import { forbidden } from '../utils/HttpError.js';

const session = (req) => ({ user: req.user, company: req.company || null, impersonated: Boolean(req.impersonatedBy) });

export async function login(req, res) {
  res.json(await authService.login({ email: req.body?.email, password: req.body?.password, ip: req.ip }));
}

export function me(req, res) {
  res.json(session(req));
}

export async function updateMe(req, res) {
  await authService.updateProfile(req.user, req.body || {});
  res.json(session(req));
}

export async function changePassword(req, res) {
  if (req.impersonatedBy) throw forbidden('Not available while signed in as a company. Reset it from the admin console.');
  await authService.changePassword(req.user, req.body || {});
  res.json({ ok: true });
}

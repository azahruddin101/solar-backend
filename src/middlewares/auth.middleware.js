import { ROLES } from '../constants/index.js';
import { Company, User } from '../models/index.js';
import { forbidden, unauthorized } from '../utils/HttpError.js';
import { verifyToken } from '../utils/token.js';

/** Bearer header, or ?token= for image requests (<img>, WebGL textures) that cannot send headers. */
export async function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) throw unauthorized();
  let claims;
  try {
    claims = verifyToken(token);
  } catch {
    throw unauthorized('Your session has expired. Sign in again.');
  }
  const user = await User.findById(claims.sub);
  if (!user) throw unauthorized('Account no longer exists');
  req.user = user;
  req.impersonatedBy = claims.by || null;
  if (user.role === ROLES.COMPANY) {
    const company = await Company.findById(user.company);
    if (!company) throw unauthorized('Company no longer exists');
    if (company.status !== 'active') throw forbidden('This company account is suspended. Contact the platform administrator.');
    req.company = company;
  }
  next();
}

export const requireRole = (role) => (req, res, next) => {
  if (req.user?.role !== role) throw forbidden();
  next();
};

export const superAdminOnly = [authenticate, requireRole(ROLES.SUPERADMIN)];
export const companyOnly = [authenticate, requireRole(ROLES.COMPANY)];

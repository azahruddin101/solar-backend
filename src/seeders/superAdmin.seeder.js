// First boot: make sure a super admin exists.
import { env } from '../config/env.js';
import { ROLES } from '../constants/index.js';
import { User } from '../models/index.js';
import { hashPassword } from '../utils/password.js';

export async function ensureSuperAdmin() {
  if (await User.exists({ role: ROLES.SUPERADMIN })) return;
  if (env.superAdminPassword.length < 8) {
    console.warn('No super admin yet. Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD (min 8 characters) in backend/.env and restart.');
    return;
  }
  await User.create({ email: env.superAdminEmail, passwordHash: await hashPassword(env.superAdminPassword), role: ROLES.SUPERADMIN, name: 'Super Admin' });
  console.log(`  + Super admin created: ${env.superAdminEmail}`);
}

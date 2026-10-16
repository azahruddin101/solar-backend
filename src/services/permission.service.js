// A staff member's effective permissions: the permissions of their roles plus the extra grants on their own account.
// Resolved from the database on every request (auth.middleware.js), so editing a role or an account applies at once.
import { ROLES } from '../constants/index.js';
import { STAFF_PERMISSIONS, isPermission } from '../constants/permissions.js';
import { Role } from '../models/index.js';

const union = (...lists) => [...new Set(lists.flat().filter(isPermission))].sort();

/** Effective permissions of one user: every permission for the owner, none for anyone else who isn't staff. */
export async function resolvePermissions(user) {
  if (user?.role === ROLES.COMPANY) return [...STAFF_PERMISSIONS];
  if (user?.role !== ROLES.AGENT) return [];
  const roleIds = user.staffRoles || [];
  const roles = roleIds.length ? await Role.find({ _id: { $in: roleIds }, company: user.company }).select('permissions').lean() : [];
  return union(user.permissions || [], ...roles.map((r) => r.permissions));
}

/** Resolves and caches the effective permissions on the loaded user document (read by hasPermission). */
export async function attachPermissions(user) {
  if (user) user.effectivePermissions = await resolvePermissions(user);
  return user;
}

/** The company's roles by id, for resolving many staff members at once (team list). */
export async function rolesById(companyId) {
  const roles = await Role.find({ company: companyId }).sort({ name: 1 }).lean();
  return new Map(roles.map((r) => [String(r._id), r]));
}

/** Effective permissions of a staff member, from an already-loaded role map. */
export function effectiveFrom(user, roleMap) {
  const roles = (user.staffRoles || []).map((id) => roleMap.get(String(id))).filter(Boolean);
  return union(user.permissions || [], ...roles.map((r) => r.permissions));
}

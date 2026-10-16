// Staff roles: named permission sets the company owner defines and gives to staff (see constants/permissions.js).
import { ROLES } from '../constants/index.js';
import { PERMISSION_CATALOG, ROLE_TEMPLATES, isPermission, normalizePermissions } from '../constants/permissions.js';
import { Role, User } from '../models/index.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import { objectId } from '../utils/validators.js';

const MAX_ROLES_PER_COMPANY = 50;

/** What the role editor needs: every area with its actions, and the starting points for a new role. */
export function permissionCatalog() {
  return {
    areas: Object.entries(PERMISSION_CATALOG).map(([id, a]) => ({
      id,
      label: a.label,
      description: a.description,
      actions: Object.entries(a.actions).map(([action, label]) => ({ id: action, label })),
    })),
    templates: ROLE_TEMPLATES.map((t) => ({ ...t, permissions: normalizePermissions(t.permissions) })),
  };
}

function parseRole(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body?.name !== undefined) {
    const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw badRequest('Give the role a name');
    if (name.length > 60) throw badRequest('Role names can be up to 60 characters');
    out.name = name;
  }
  if (body?.description !== undefined) out.description = String(body.description ?? '').trim().slice(0, 200);
  if (!partial || body?.permissions !== undefined) {
    if (!Array.isArray(body?.permissions)) throw badRequest('Permissions must be a list');
    const unknown = body.permissions.map((p) => String(p ?? '').trim()).filter((p) => p && !isPermission(p));
    if (unknown.length) throw badRequest(`Unknown permission: ${unknown.slice(0, 3).join(', ')}`);
    out.permissions = normalizePermissions(body.permissions);
  }
  return out;
}

const present = (role, usedBy = 0) => ({ ...role.toJSON(), usedBy });

async function usage(companyId) {
  const rows = await User.aggregate([
    { $match: { company: companyId, role: ROLES.AGENT } },
    { $unwind: '$staffRoles' },
    { $group: { _id: '$staffRoles', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

async function getRole(company, id) {
  const role = await Role.findOne({ _id: objectId(id, 'Role'), company: company._id });
  if (!role) throw notFound('Role');
  return role;
}

/** Names are unique per company, ignoring case (the unique index backs this up against two saves at once). */
async function assertNameFree(company, name, exceptId = null) {
  const taken = await Role.exists({ company: company._id, name, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).collation({ locale: 'en', strength: 2 });
  if (taken) throw conflict('A role with this name already exists');
}

const duplicateName = (e) => {
  if (e?.code === 11000) return conflict('A role with this name already exists');
  return e;
};

export async function listRoles(company) {
  const [roles, used] = await Promise.all([Role.find({ company: company._id }).collation({ locale: 'en', strength: 2 }).sort({ name: 1 }), usage(company._id)]);
  return roles.map((r) => present(r, used.get(r.id) || 0));
}

export async function createRole(company, body) {
  if ((await Role.countDocuments({ company: company._id })) >= MAX_ROLES_PER_COMPANY) throw badRequest(`You can have up to ${MAX_ROLES_PER_COMPANY} roles`);
  const fields = parseRole(body);
  await assertNameFree(company, fields.name);
  try {
    const role = await Role.create({ ...fields, company: company._id });
    return present(role);
  } catch (e) {
    throw duplicateName(e);
  }
}

/** Changes apply to everyone with the role on their next request. */
export async function updateRole(company, id, body) {
  const role = await getRole(company, id);
  const fields = parseRole(body, { partial: true });
  if (fields.name !== undefined) await assertNameFree(company, fields.name, role._id);
  Object.assign(role, fields);
  try {
    await role.save();
  } catch (e) {
    throw duplicateName(e);
  }
  return present(role, (await usage(company._id)).get(role.id) || 0);
}

/** A role still given to someone can't be deleted: take it off them first, so nobody loses access by surprise. */
export async function deleteRole(company, id) {
  const role = await getRole(company, id);
  const holders = await User.countDocuments({ company: company._id, role: ROLES.AGENT, staffRoles: role._id });
  if (holders) throw badRequest(`${holders} staff member${holders > 1 ? 's have' : ' has'} this role. Remove it from them first.`);
  await role.deleteOne();
}

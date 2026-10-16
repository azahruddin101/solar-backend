import * as roleService from '../services/role.service.js';

export function catalog(req, res) {
  res.json(roleService.permissionCatalog());
}

export async function list(req, res) {
  res.json(await roleService.listRoles(req.company));
}

export async function create(req, res) {
  res.status(201).json(await roleService.createRole(req.company, req.body));
}

export async function update(req, res) {
  res.json(await roleService.updateRole(req.company, req.params.id, req.body));
}

export async function remove(req, res) {
  await roleService.deleteRole(req.company, req.params.id);
  res.json({ ok: true });
}

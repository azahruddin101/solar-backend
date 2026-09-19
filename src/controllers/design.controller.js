import * as designService from '../services/design.service.js';

export async function list(req, res) {
  res.json(await designService.listDesigns(req.company, { client: req.query.client }));
}

export async function create(req, res) {
  res.status(201).json(await designService.createDesign(req.company, req.body));
}

export async function get(req, res) {
  res.json(await designService.getDesign(req.company, req.params.id));
}

export async function update(req, res) {
  res.json(await designService.updateDesign(req.company, req.params.id, req.body));
}

export async function duplicate(req, res) {
  res.status(201).json(await designService.duplicateDesign(req.company, req.params.id));
}

export async function remove(req, res) {
  await designService.deleteDesign(req.company, req.params.id);
  res.json({ ok: true });
}

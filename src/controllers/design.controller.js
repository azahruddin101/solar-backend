import * as designService from '../services/design.service.js';
import { getLifecycle } from '../services/lifecycle.service.js';

export async function list(req, res) {
  res.json(await designService.listDesigns(req.company, { client: req.query.client, page: req.query.page, limit: req.query.limit }));
}

export async function create(req, res) {
  res.status(201).json(await designService.createDesign(req.company, req.user, req.body));
}

export async function get(req, res) {
  res.json(await designService.getDesign(req.company, req.params.id));
}

export async function update(req, res) {
  res.json(await designService.updateDesign(req.company, req.user, req.params.id, req.body));
}

export async function duplicate(req, res) {
  res.status(201).json(await designService.duplicateDesign(req.company, req.user, req.params.id));
}

export async function lifecycle(req, res) {
  res.json(await getLifecycle(req.company._id, req.params.id));
}

export async function share(req, res) {
  res.json(await designService.ensureShare(req.company, req.params.id));
}

export async function unshare(req, res) {
  res.json(await designService.revokeShare(req.company, req.params.id));
}

export async function remove(req, res) {
  await designService.deleteDesign(req.company, req.params.id);
  res.json({ ok: true });
}

export async function sendForReview(req, res) {
  res.json(await designService.sendDesignForClientReview(req.company, req.user, req.params.id, req.body));
}

export async function listVersions(req, res) {
  res.json(await designService.listDesignVersions(req.company, req.params.id));
}

export async function createVersion(req, res) {
  if (!req.file) return res.status(400).json({ error: 'A PDF file is required' });
  res.status(201).json(await designService.createDesignVersion(req.company, req.user, req.params.id, req.file.filename));
}

export async function restoreVersion(req, res) {
  res.json(await designService.restoreDesignVersion(req.company, req.user, req.params.id, req.params.versionId));
}

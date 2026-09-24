import * as clientService from '../services/client.service.js';

export async function list(req, res) {
  res.json(await clientService.listClients(req.company));
}

export async function get(req, res) {
  const client = await clientService.getClient(req.company, req.params.id);
  res.json(client);
}

export async function create(req, res) {
  res.status(201).json(await clientService.createClient(req.company, req.user, req.body));
}

export async function update(req, res) {
  res.json(await clientService.updateClient(req.company, req.params.id, req.body));
}

export async function remove(req, res) {
  await clientService.deleteClient(req.company, req.params.id);
  res.json({ ok: true });
}

export async function uploadDoc(req, res) {
  if (!req.file) return res.status(400).json({ error: 'Please choose a file to upload' });
  res.json({
    name: req.file.originalname,
    url: `/uploads/${req.file.filename}`,
    size: req.file.size,
    mimetype: req.file.mimetype,
    uploadedAt: new Date(),
  });
}


import * as clientService from '../services/client.service.js';

export async function list(req, res) {
  res.json(await clientService.listClients(req.company));
}

export async function create(req, res) {
  res.status(201).json(await clientService.createClient(req.company, req.body));
}

export async function update(req, res) {
  res.json(await clientService.updateClient(req.company, req.params.id, req.body));
}

export async function remove(req, res) {
  await clientService.deleteClient(req.company, req.params.id);
  res.json({ ok: true });
}

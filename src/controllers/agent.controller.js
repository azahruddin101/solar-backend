import * as agentService from '../services/agent.service.js';

export async function list(req, res) {
  res.json(await agentService.listAgents(req.company));
}

export async function analytics(req, res) {
  res.json(await agentService.teamAnalytics(req.company));
}

export async function create(req, res) {
  res.status(201).json(await agentService.createAgent(req.company, req.body));
}

export async function update(req, res) {
  res.json(await agentService.updateAgent(req.company, req.params.id, req.body));
}

export async function remove(req, res) {
  await agentService.deleteAgent(req.company, req.params.id);
  res.json({ ok: true });
}

async function agentListRow(company, id) {
  const row = (await agentService.listAgents(company)).find((a) => a.id === id);
  if (!row) {
    const err = new Error('Agent not found');
    err.status = 404;
    throw err;
  }
  return row;
}

export async function uploadPhoto(req, res) {
  await agentService.saveAgentPhoto(req.company, req.params.id, req.file);
  res.json(await agentListRow(req.company, req.params.id));
}

export async function removePhoto(req, res) {
  await agentService.deleteAgentPhoto(req.company, req.params.id);
  res.json(await agentListRow(req.company, req.params.id));
}

import * as planService from '../services/plan.service.js';

export async function list(req, res) {
  res.json(await planService.listPlans());
}

export async function create(req, res) {
  res.status(201).json(await planService.createPlan(req.body));
}

export async function update(req, res) {
  res.json(await planService.updatePlan(req.params.id, req.body));
}

export async function remove(req, res) {
  await planService.deletePlan(req.params.id);
  res.json({ ok: true });
}

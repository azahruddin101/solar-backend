import * as companyService from '../services/company.service.js';
import * as projectService from '../services/project.service.js';
import { getLifecycleForProject } from '../services/lifecycle.service.js';

/* company owner */

export async function getSteps(req, res) {
  res.json(req.company.installationSteps);
}

export async function updateSteps(req, res) {
  res.json(await companyService.updateInstallationSteps(req.company, req.body));
}

export async function list(req, res) {
  res.json(await projectService.listProjects(req.company));
}

export async function start(req, res) {
  res.status(201).json(await projectService.startProject(req.company, req.user, req.body));
}

export async function get(req, res) {
  res.json(await projectService.getProject(req.company, req.params.id));
}

export async function lifecycle(req, res) {
  res.json(await getLifecycleForProject(req.company._id, req.params.id));
}

export async function remove(req, res) {
  await projectService.deleteProject(req.company, req.params.id);
  res.json({ ok: true });
}

export async function addStep(req, res) {
  res.status(201).json(await projectService.addStep(req.company, req.user, req.params.id, req.body));
}

export async function updateStep(req, res) {
  res.json(await projectService.updateStep(req.company, req.user, req.params.id, req.params.stepId, req.body));
}

export async function removeStep(req, res) {
  res.json(await projectService.removeStep(req.company, req.user, req.params.id, req.params.stepId));
}

export async function uploadStepPhoto(req, res) {
  res.status(201).json(await projectService.saveStepPhoto(req.company, req.user, req.params.id, req.params.stepId, req.file));
}

export async function addNote(req, res) {
  res.status(201).json(await projectService.addNote(req.company, req.user, req.params.id, req.body));
}

/* agent */

export async function listMine(req, res) {
  res.json(await projectService.listForAgent(req.user));
}

export async function getMine(req, res) {
  res.json(await projectService.getForAgent(req.user, req.params.id));
}

export async function lifecycleMine(req, res) {
  await projectService.assertAssigned(req.user, req.params.id);
  res.json(await getLifecycleForProject(req.user.company, req.params.id, { forAgent: true }));
}

export async function setMyStepStatus(req, res) {
  res.json(await projectService.setStatusAsAgent(req.user, req.params.id, req.params.stepId, req.body));
}

export async function uploadMyStepPhoto(req, res) {
  res.status(201).json(await projectService.saveStepPhotoAsAgent(req.user, req.params.id, req.params.stepId, req.file));
}

export async function addMyNote(req, res) {
  res.status(201).json(await projectService.addNoteAsAgent(req.user, req.params.id, req.body));
}

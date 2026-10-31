import * as companyService from '../services/company.service.js';
import { createAmcVisit as createAmcVisitService, assignAmcRequest as assignAmcRequestService, assignAmcVisit as assignAmcVisitService, listAmcOverview, listAmcRequests, listAmcVisits } from '../services/amc.service.js';
import * as projectService from '../services/project.service.js';
import { getLifecycleForProject } from '../services/lifecycle.service.js';

/* company owner */

export async function getSteps(req, res) {
  res.json(req.company.installationSteps);
}

export async function updateSteps(req, res) {
  res.json(await companyService.updateInstallationSteps(req.company, req.body));
}

export async function getAmcTemplates(req, res) {
  res.json(req.company.amcTemplates || []);
}

export async function updateAmcTemplates(req, res) {
  res.json(await companyService.updateAmcTemplates(req.company, req.body));
}

export async function completeAmcVisit(req, res) {
  res.json(await projectService.completeAmcVisit(req.company, req.user, req.params.id, req.params.visitId, req.body));
}

export async function completeAmcVisitMine(req, res) {
  res.json(await projectService.completeAmcVisitAsAgent(req.user, req.params.id, req.params.visitId, req.body));
}

const amcOverviewQuery = (q) => ({
  amcFrom: q.amcFrom,
  amcTo: q.amcTo,
  installedFrom: q.installedFrom,
  installedTo: q.installedTo,
  nextAmc: q.nextAmc,
  filter: q.filter,
});

export async function amcOverview(req, res) {
  res.json(await listAmcOverview(req.company, amcOverviewQuery(req.query)));
}

export async function amcOverviewMine(req, res) {
  res.json(await listAmcOverview({ _id: req.user.company }, { agentId: req.user._id, ...amcOverviewQuery(req.query) }));
}

export async function createAmcVisit(req, res) {
  res.status(201).json(await createAmcVisitService(req.company, req.user, req.params.id, req.body));
}

export async function invoiceAmcParts(req, res) {
  res.status(201).json(await projectService.invoiceAmcParts(req.company, req.user, req.params.id, req.params.visitId, req.body));
}

export async function invoiceAmcPartsMine(req, res) {
  res.status(201).json(await projectService.invoiceAmcPartsAsAgent(req.user, req.params.id, req.params.visitId, req.body));
}

export async function amcPartsInvoice(req, res) {
  res.json(await projectService.getAmcPartsInvoice(req.company, req.params.id, req.params.visitId));
}

export async function amcPartsInvoiceMine(req, res) {
  res.json(await projectService.getAmcPartsInvoiceAsAgent(req.user, req.params.id, req.params.visitId));
}

export async function attachAmcPartsInvoicePdf(req, res) {
  res.status(201).json(await projectService.attachAmcPartsInvoicePdf(req.company, req.params.id, req.params.visitId, req.file?.filename));
}

export async function attachAmcPartsInvoicePdfMine(req, res) {
  res.status(201).json(await projectService.attachAmcPartsInvoicePdfAsAgent(req.user, req.params.id, req.params.visitId, req.file?.filename));
}

export async function amcVisits(req, res) {
  res.json(await listAmcVisits(req.company));
}

export async function stepBoard(req, res) {
  res.json(await projectService.stepBoard(req.company));
}

export async function stepBoardMine(req, res) {
  res.json(await projectService.stepBoard({ _id: req.user.company }, { agentId: req.user._id }));
}

export async function amcVisitsMine(req, res) {
  res.json(await listAmcVisits({ _id: req.user.company }, { agentId: req.user._id }));
}

export async function assignAmcVisit(req, res) {
  res.json(await assignAmcVisitService(req.company, req.user, req.params.id, req.params.visitId, req.body.assigneeId));
}

export async function amcRequests(req, res) {
  res.json(await listAmcRequests(req.company, { status: req.query.status }));
}

export async function assignAmcRequest(req, res) {
  res.json(await assignAmcRequestService(req.company, req.user, req.params.designId, req.params.requestId, req.body.assigneeId));
}

export async function list(req, res) {
  res.json(await projectService.listProjects(req.company, {
    page: req.query.page,
    limit: req.query.limit,
    from: req.query.from,
    to: req.query.to,
    show: req.query.show,
  }));
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

export async function assignees(req, res) {
  res.json(await projectService.listAssignableStaff(req.company));
}

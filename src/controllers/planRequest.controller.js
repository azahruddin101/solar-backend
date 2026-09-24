import * as planRequestService from '../services/planRequest.service.js';

export async function companyCurrent(req, res) {
  res.json(await planRequestService.getCurrentPlanRequest(req.company));
}

export async function companySubmit(req, res) {
  res.status(201).json(await planRequestService.submitPlanRequest(req.company, req.body));
}

export async function companyCancel(req, res) {
  res.json(await planRequestService.cancelPlanRequest(req.company));
}

export async function adminList(req, res) {
  res.json(await planRequestService.listPlanRequests());
}

export async function adminApprove(req, res) {
  res.json(await planRequestService.approvePlanRequest(req.params.id, req.body, req.user));
}

export async function adminReject(req, res) {
  res.json(await planRequestService.rejectPlanRequest(req.params.id, req.body, req.user));
}

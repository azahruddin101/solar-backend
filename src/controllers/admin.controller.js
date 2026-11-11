import { countNewFreeProposals } from '../services/freeProposal.service.js';
// Super admin: manage every company on the platform.
import { Company, Plan, PlanRequest } from '../models/index.js';
import * as companyService from '../services/company.service.js';
import * as designService from '../services/design.service.js';

export async function stats(req, res) {
  res.json(await companyService.platformStats());
}

/** The numbers beside the admin sidebar links. `planRequests` counts only the ones waiting for a decision. */
export async function counts(req, res) {
  const [companies, plans, planRequests, freeProposals] = await Promise.all([Company.countDocuments({}), Plan.countDocuments({}), PlanRequest.countDocuments({ status: 'pending' }), countNewFreeProposals()]);
  res.json({ companies, plans, planRequests, freeProposals });
}

export async function listCompanies(req, res) {
  res.json(await companyService.listCompanies());
}

export async function createCompany(req, res) {
  res.status(201).json(await companyService.createCompany(req.body));
}

export async function updateCompany(req, res) {
  res.json(await companyService.updateCompanyAsAdmin(req.params.id, req.body));
}

export async function resetPassword(req, res) {
  await companyService.resetCompanyPassword(req.params.id, req.body?.password, req.body?.who === 'admin' ? 'admin' : 'owner');
  res.json({ ok: true });
}

export async function impersonate(req, res) {
  const who = req.body?.who === 'admin' ? 'admin' : 'owner';
  res.json(await companyService.impersonate(req.params.id, req.user, who));
}

export async function deleteCompany(req, res) {
  await companyService.deleteCompany(req.params.id);
  res.json({ ok: true });
}

/** Deletes every draft design (any company) that has sat untouched for 30+ days. */
export async function cleanupDraftDesigns(req, res) {
  res.json(await designService.deleteStaleDraftDesigns(30));
}

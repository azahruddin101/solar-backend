import * as org from '../services/organization.service.js';
import * as assetService from '../services/asset.service.js';

export async function getOrganization(req, res) {
  res.json(await org.getOrganization(req.user));
}

export async function getOverview(req, res) {
  res.json(await org.getOrganizationOverview(req.user));
}

export async function listBranches(req, res) {
  res.json(await org.listBranches(req.user));
}

export async function createBranch(req, res) {
  res.status(201).json(await org.createBranch(req.user, req.body));
}

export async function updateBranch(req, res) {
  res.json(await org.updateBranchCaps(req.user, req.params.id, req.body));
}

/** The company admin's branding images (logo, e-signature, QR), saved on the organization. */
export async function uploadOrganizationAsset(req, res) {
  await assetService.saveAsset(req.organization, req.params.kind, req.file);
  res.json(await org.getOrganization(req.user));
}

export async function deleteOrganizationAsset(req, res) {
  await assetService.deleteAsset(req.organization, req.params.kind);
  res.json(await org.getOrganization(req.user));
}

export async function updateOrganization(req, res) {
  res.json(await org.updateOrgCompany(req.body, req.user));
}

export async function updateCatalogSettings(req, res) {
  res.json(await org.updateOrgCatalogSettings(req.body, req.user));
}

export async function updateLeadForm(req, res) {
  res.json(await org.updateOrgLeadForm(req.body, req.user));
}

export async function updateInstallationSteps(req, res) {
  res.json(await org.updateOrgInstallationSteps(req.body, req.user));
}

export async function updateAmcTemplates(req, res) {
  res.json(await org.updateOrgAmcTemplates(req.body, req.user));
}

export async function updateLoanSteps(req, res) {
  res.json(await org.updateOrgLoanSteps(req.body, req.user));
}

export async function updateSubsidySteps(req, res) {
  res.json(await org.updateOrgSubsidySteps(req.body, req.user));
}

export async function updateExpenseReasons(req, res) {
  res.json(await org.updateOrgExpenseReasons(req.body, req.user));
}

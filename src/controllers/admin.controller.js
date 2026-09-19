// Super admin: manage every company on the platform.
import * as companyService from '../services/company.service.js';

export async function stats(req, res) {
  res.json(await companyService.platformStats());
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
  await companyService.resetCompanyPassword(req.params.id, req.body?.password);
  res.json({ ok: true });
}

export async function impersonate(req, res) {
  res.json(await companyService.impersonate(req.params.id, req.user));
}

export async function deleteCompany(req, res) {
  await companyService.deleteCompany(req.params.id);
  res.json({ ok: true });
}

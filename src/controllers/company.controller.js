// The signed-in company's own profile, branding (theme, logo, e-signature, QR) and pricing.
import * as assetService from '../services/asset.service.js';
import * as companyService from '../services/company.service.js';

export function getCompany(req, res) {
  res.json(req.company);
}

export async function updateCompany(req, res) {
  res.json(await companyService.updateOwnCompany(req.company, req.body));
}

export async function uploadAsset(req, res) {
  res.json(await assetService.saveAsset(req.company, req.params.kind, req.file));
}

export async function deleteAsset(req, res) {
  res.json(await assetService.deleteAsset(req.company, req.params.kind));
}

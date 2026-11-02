// The signed-in company's own profile, branding (theme, logo, e-signature, QR) and pricing.
import * as assetService from '../services/asset.service.js';
import * as companyService from '../services/company.service.js';
import { ownerCompanyView } from '../utils/companyView.js';
import { applyOrganizationMasters } from '../services/tenant.service.js';

const companyPayload = ownerCompanyView;

export async function getCompany(req, res) {
  res.json(await companyPayload(req.company));
}

export async function updateCompany(req, res) {
  await companyService.saveCompanySettings({ company: req.company, organization: req.organization, user: req.user }, req.body);
  res.json(await companyPayload(req.company));
}

/** Product units and default pricing only — the slice of company settings staff with the "catalog" permission may change. Returns only that slice: a catalog-only staff account has no read access to the rest of the company's profile. */
export async function updateCatalogSettings(req, res) {
  const company = await companyService.updateCatalogSettings(req.company, req.body);
  res.json({ currency: company.currency, tariff: company.tariff, otherCostPerKw: company.otherCostPerKw, productUnits: company.productUnits });
}

// Logo, e-signature and QR are shared branding: saved on the organization (routes gate them to whoever manages the
// masters), then shown on the branch through the usual overlay.
const brandingTarget = (req) => req.organization || req.company;

export async function uploadAsset(req, res) {
  await assetService.saveAsset(brandingTarget(req), req.params.kind, req.file);
  applyOrganizationMasters(req.company, req.organization);
  res.json(await companyPayload(req.company));
}

export async function deleteAsset(req, res) {
  await assetService.deleteAsset(brandingTarget(req), req.params.kind);
  applyOrganizationMasters(req.company, req.organization);
  res.json(await companyPayload(req.company));
}

export async function updateLeadForm(req, res) {
  res.json({ fields: await companyService.updateLeadForm(req.company, req.body) });
}

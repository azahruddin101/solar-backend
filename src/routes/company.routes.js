import { Router } from 'express';
import * as company from '../controllers/company.controller.js';
import * as planRequest from '../controllers/planRequest.controller.js';
import * as subscription from '../controllers/subscription.controller.js';
import { requireRole } from '../middlewares/auth.middleware.js';
import { ROLES } from '../constants/index.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { uploadImage } from '../middlewares/upload.middleware.js';
import { googleLeadRoutes, metaRoutes, sheetRoutes } from '../integrations/leads.js';

const router = Router();
// Everything under /api/company is the company owner's: profile, branding, subscription, masters (units,
// pricing defaults, currency) and lead integrations. Staff and clients are refused here by default, so a
// route added later can't be reached by them by accident. (The Meta OAuth callback and the Google Ads
// webhook are public and are mounted in app.js, before this router.)
const ownerOnly = requireRole(ROLES.COMPANY);
router.use(ownerOnly);

router.get('/', ownerOnly, company.getCompany);
router.get('/subscription', ownerOnly, subscription.getSubscription);
router.get('/subscription/upgrades', ownerOnly, subscription.listUpgrades);
router.get('/subscription/quote', ownerOnly, subscription.quoteUpgrade);
router.get('/plan-request', ownerOnly, planRequest.companyCurrent);
router.post('/plan-request', ownerOnly, rateLimit({ name: 'plan-request', windowMs: 60 * 60 * 1000, max: 10 }), validate(S.planRequestSchema), planRequest.companySubmit);
router.delete('/plan-request', ownerOnly, planRequest.companyCancel);
router.put('/', ownerOnly, validate(S.companySelfSchema), company.updateCompany);
// the company's lead form fields (a master)
router.put('/lead-form', ownerOnly, company.updateLeadForm);
router.put('/catalog-settings', ownerOnly, validate(S.catalogSettingsSchema), company.updateCatalogSettings);
router.post('/assets/:kind', ownerOnly, uploadImage, company.uploadAsset);
router.delete('/assets/:kind', ownerOnly, company.deleteAsset);

// Meta Lead Ads + Google Ads (per company). Their public OAuth callback and webhook live in app.js.
router.use('/integrations/meta', ownerOnly, metaRoutes);
router.use('/integrations/sheet', ownerOnly, sheetRoutes);
router.use('/google-leads', ownerOnly, googleLeadRoutes);

export default router;

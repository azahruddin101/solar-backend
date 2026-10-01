import { Router } from 'express';
import * as company from '../controllers/company.controller.js';
import * as planRequest from '../controllers/planRequest.controller.js';
import * as subscription from '../controllers/subscription.controller.js';
import { permissionOnly, requireRole } from '../middlewares/auth.middleware.js';
import { ROLES } from '../constants/index.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { uploadImage } from '../middlewares/upload.middleware.js';

const router = Router();
// mounted with withAreaAccess('catalog') below the owner-only routes — see routes/index.js: only
// /catalog-settings is reachable by staff (and needs 'catalog:update' there); everything else here
// still needs requireRole(ROLES.COMPANY).
const ownerOnly = requireRole(ROLES.COMPANY);

router.get('/', ownerOnly, company.getCompany);
router.get('/subscription', ownerOnly, subscription.getSubscription);
router.get('/subscription/upgrades', ownerOnly, subscription.listUpgrades);
router.get('/subscription/quote', ownerOnly, subscription.quoteUpgrade);
router.get('/plan-request', ownerOnly, planRequest.companyCurrent);
router.post('/plan-request', ownerOnly, rateLimit({ name: 'plan-request', windowMs: 60 * 60 * 1000, max: 10 }), validate(S.planRequestSchema), planRequest.companySubmit);
router.delete('/plan-request', ownerOnly, planRequest.companyCancel);
router.put('/', ownerOnly, validate(S.companySelfSchema), company.updateCompany);
router.put('/catalog-settings', permissionOnly('catalog', 'update'), validate(S.catalogSettingsSchema), company.updateCatalogSettings);
router.post('/assets/:kind', ownerOnly, uploadImage, company.uploadAsset);
router.delete('/assets/:kind', ownerOnly, company.deleteAsset);

export default router;

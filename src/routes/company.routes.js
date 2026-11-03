import { Router } from 'express';
import * as company from '../controllers/company.controller.js';
import * as planRequest from '../controllers/planRequest.controller.js';
import * as subscription from '../controllers/subscription.controller.js';
import { branchOnly, mastersOnly, requireRole } from '../middlewares/auth.middleware.js';
import { ROLES } from '../constants/index.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { uploadImage } from '../middlewares/upload.middleware.js';
import { googleLeadRoutes, metaRoutes, sheetRoutes } from '../integrations/leads.js';

const router = Router();
router.use(branchOnly);

router.get('/', company.getCompany);
router.get('/subscription', subscription.getSubscription);
router.get('/subscription/usage', subscription.getUsage);
router.get('/subscription/upgrades', subscription.listUpgrades);
router.get('/subscription/quote', subscription.quoteUpgrade);
router.get('/plan-request', planRequest.companyCurrent);
router.post('/plan-request', rateLimit({ name: 'plan-request', windowMs: 60 * 60 * 1000, max: 10 }), validate(S.planRequestSchema), planRequest.companySubmit);
router.delete('/plan-request', planRequest.companyCancel);
router.put('/', validate(S.companySelfSchema), company.updateCompany);
// shared branding: checked before the file is stored, so a refused upload leaves no file behind
router.post('/assets/:kind', mastersOnly, uploadImage, company.uploadAsset);
router.delete('/assets/:kind', mastersOnly, company.deleteAsset);

router.use('/integrations/meta', requireRole(ROLES.BRANCH, ROLES.COMPANY), metaRoutes);
router.use('/integrations/sheet', requireRole(ROLES.BRANCH, ROLES.COMPANY), sheetRoutes);
router.use('/google-leads', requireRole(ROLES.BRANCH, ROLES.COMPANY), googleLeadRoutes);

export default router;

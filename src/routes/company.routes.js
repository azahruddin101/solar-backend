import { Router } from 'express';
import * as company from '../controllers/company.controller.js';
import * as planRequest from '../controllers/planRequest.controller.js';
import * as subscription from '../controllers/subscription.controller.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { uploadImage } from '../middlewares/upload.middleware.js';

const router = Router();

router.get('/', company.getCompany);
router.get('/subscription', subscription.getSubscription);
router.get('/subscription/upgrades', subscription.listUpgrades);
router.get('/subscription/quote', subscription.quoteUpgrade);
router.get('/plan-request', planRequest.companyCurrent);
router.post('/plan-request', rateLimit({ name: 'plan-request', windowMs: 60 * 60 * 1000, max: 10 }), validate(S.planRequestSchema), planRequest.companySubmit);
router.delete('/plan-request', planRequest.companyCancel);
router.put('/', validate(S.companySelfSchema), company.updateCompany);
router.post('/assets/:kind', uploadImage, company.uploadAsset);
router.delete('/assets/:kind', company.deleteAsset);

export default router;

import { Router } from 'express';
import * as admin from '../controllers/admin.controller.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import * as plans from '../controllers/plan.controller.js';
import * as planRequests from '../controllers/planRequest.controller.js';

const router = Router();

router.get('/plans', plans.list);
router.post('/plans', validate(S.planSchema), plans.create);
router.patch('/plans/:id', validate(S.planUpdateSchema), plans.update);
router.delete('/plans/:id', plans.remove);

router.get('/plan-requests', planRequests.adminList);
router.post('/plan-requests/:id/approve', validate(S.planRequestApproveSchema), planRequests.adminApprove);
router.post('/plan-requests/:id/reject', validate(S.planRequestRejectSchema), planRequests.adminReject);

router.get('/stats', admin.stats);
router.get('/counts', admin.counts);
router.post('/designs/cleanup-drafts', admin.cleanupDraftDesigns);
router.get('/companies', admin.listCompanies);
router.post('/companies', validate(S.adminCompanyCreateSchema), admin.createCompany);
router.patch('/companies/:id', validate(S.adminCompanyUpdateSchema), admin.updateCompany);
router.delete('/companies/:id', admin.deleteCompany);
router.post('/companies/:id/password', validate(S.passwordResetSchema), admin.resetPassword);
router.post('/companies/:id/impersonate', admin.impersonate);

export default router;

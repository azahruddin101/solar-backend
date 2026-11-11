import { Router } from 'express';
import * as admin from '../controllers/admin.controller.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import * as plans from '../controllers/plan.controller.js';
import * as planRequests from '../controllers/planRequest.controller.js';
import * as free from '../services/freeProposal.service.js';
import { wrap } from '../utils/wrap.js';

const router = Router();

router.get('/plans', plans.list);
router.post('/plans', validate(S.planSchema), plans.create);
router.patch('/plans/:id', validate(S.planUpdateSchema), plans.update);
router.delete('/plans/:id', plans.remove);

router.get('/plan-requests', planRequests.adminList);
router.post('/plan-requests/:id/approve', validate(S.planRequestApproveSchema), planRequests.adminApprove);
router.post('/plan-requests/:id/reject', validate(S.planRequestRejectSchema), planRequests.adminReject);

// free proposals made by visitors on the public site: the platform's own leads
router.get('/free-proposals', wrap(() => free.listFreeProposals()));
router.get('/free-proposals/:id', wrap((req) => free.adminGetFreeProposal(req.params.id)));
router.patch('/free-proposals/:id', validate(S.freeProposalUpdateSchema), wrap((req) => free.adminUpdateFreeProposal(req.params.id, req.body)));
router.delete('/free-proposals/:id', wrap((req) => free.removeFreeProposal(req.params.id)));

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

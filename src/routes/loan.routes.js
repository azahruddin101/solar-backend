import { Router } from 'express';
import { ROLES } from '../constants/index.js';
import { permissionOnly, requireRole } from '../middlewares/auth.middleware.js';
import { uploadLoanDocument } from '../middlewares/upload.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as loans from '../services/loan.service.js';
import * as S from '../validation/schemas.js';
import { wrap } from '../utils/wrap.js';

const router = Router();
const view = permissionOnly('loans', 'view');
const update = permissionOnly('loans', 'update');

router.get('/steps', view, wrap((req) => req.company.loanSteps || []));
// the loan step template is a company master: only the owner changes it
router.put('/steps', requireRole(ROLES.COMPANY), validate(S.loanStepsSchema), wrap((req) => loans.updateLoanSteps(req.company, req.body)));
router.get('/', view, wrap((req) => loans.listLoans(req.company, { q: req.query.q, status: req.query.status })));
router.get('/proposal/:designId', view, wrap((req) => loans.getLoanOfDesign(req.company, req.params.designId))); // null when the proposal has no loan
router.get('/:id', view, wrap((req) => loans.getLoan(req.company, req.params.id)));
router.put('/:id', update, validate(S.loanUpdateSchema), wrap((req) => loans.updateLoan(req.company, req.user, req.params.id, req.body)));
router.put('/:id/steps/:stepId', update, validate(S.loanStepUpdateSchema), wrap((req) => loans.updateLoanStep(req.company, req.user, req.params.id, req.params.stepId, req.body)));
router.post('/:id/steps/:stepId/documents', update, uploadLoanDocument, wrap((req) => loans.addStepDocument(req.company, req.user, req.params.id, req.params.stepId, req.file), 201));
router.put('/:id/steps/:stepId/documents/:docId', update, validate(S.loanDocumentRenameSchema), wrap((req) => loans.renameStepDocument(req.company, req.user, req.params.id, req.params.stepId, req.params.docId, req.body.name)));
router.delete('/:id/steps/:stepId/documents/:docId', update, wrap((req) => loans.removeStepDocument(req.company, req.user, req.params.id, req.params.stepId, req.params.docId)));
router.post('/:id/sync-steps', update, wrap((req) => loans.syncLoanSteps(req.company, req.user, req.params.id)));

export default router;

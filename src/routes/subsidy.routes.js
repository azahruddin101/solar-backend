import { Router } from 'express';
import { ROLES } from '../constants/index.js';
import { permissionOnly, requireRole } from '../middlewares/auth.middleware.js';
import { uploadSubsidyDocument } from '../middlewares/upload.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as subsidies from '../services/subsidy.service.js';
import * as S from '../validation/schemas.js';
import { wrap } from '../utils/wrap.js';

const router = Router();
const view = permissionOnly('subsidies', 'view');
const update = permissionOnly('subsidies', 'update');

router.get('/steps', view, wrap((req) => req.company.subsidySteps || []));
// the subsidy step template is a company master: only the owner changes it
router.put('/steps', requireRole(ROLES.COMPANY), validate(S.subsidyStepsSchema), wrap((req) => subsidies.updateSubsidySteps(req.company, req.body)));
router.get('/', view, wrap((req) => subsidies.listSubsidies(req.company, { q: req.query.q, status: req.query.status })));
router.get('/proposal/:designId', view, wrap((req) => subsidies.getSubsidyOfDesign(req.company, req.params.designId))); // null when the proposal has no subsidy
router.get('/:id', view, wrap((req) => subsidies.getSubsidy(req.company, req.params.id)));
router.put('/:id', update, validate(S.subsidyUpdateSchema), wrap((req) => subsidies.updateSubsidy(req.company, req.user, req.params.id, req.body)));
router.put('/:id/steps/:stepId', update, validate(S.subsidyStepUpdateSchema), wrap((req) => subsidies.updateSubsidyStep(req.company, req.user, req.params.id, req.params.stepId, req.body)));
router.post('/:id/steps/:stepId/documents', update, uploadSubsidyDocument, wrap((req) => subsidies.addStepDocument(req.company, req.user, req.params.id, req.params.stepId, req.file), 201));
router.put('/:id/steps/:stepId/documents/:docId', update, validate(S.subsidyDocumentRenameSchema), wrap((req) => subsidies.renameStepDocument(req.company, req.user, req.params.id, req.params.stepId, req.params.docId, req.body.name)));
router.delete('/:id/steps/:stepId/documents/:docId', update, wrap((req) => subsidies.removeStepDocument(req.company, req.user, req.params.id, req.params.stepId, req.params.docId)));
router.post('/:id/sync-steps', update, wrap((req) => subsidies.syncSubsidySteps(req.company, req.user, req.params.id)));

export default router;

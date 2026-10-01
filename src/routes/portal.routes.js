// The client portal: proposals and account. Clients may submit a response on open proposals.
import { Router } from 'express';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import * as portal from '../services/portal.service.js';

const router = Router();
const wrap = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    next(err);
  }
};

router.get('/me', wrap((req) => portal.me(req.user)));
router.get('/proposals', wrap((req) => portal.listProposals(req.user)));
router.get('/proposals/:id', wrap((req) => portal.getProposal(req.user, req.params.id)));
router.post('/proposals/:id/response', validate(S.portalProposalResponseSchema), wrap((req) => portal.respondToProposal(req.user, req.params.id, req.body)));
router.get('/proposals/:id/design', wrap((req) => portal.getDesignData(req.user, req.params.id)));
router.get('/catalog', wrap((req) => portal.viewerCatalog(req.user)));

export default router;

// The client portal: proposals, account, and help requests to their company. Clients may submit a response on open proposals.
import { Router } from 'express';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import * as portal from '../services/portal.service.js';
import * as tickets from '../controllers/clientTicket.controller.js';
import { uploadClientTicketFiles } from '../middlewares/upload.middleware.js';

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

// Help & support: the client's own requests to their solar company (never the company's tickets with the platform)
router.get('/tickets', tickets.list);
router.get('/tickets/unread-count', tickets.unread);
router.post('/tickets', uploadClientTicketFiles, validate(S.clientTicketCreateSchema), tickets.create);
router.get('/tickets/:id', tickets.get);
router.post('/tickets/:id/messages', uploadClientTicketFiles, validate(S.ticketMessageSchema), tickets.message);
router.put('/tickets/:id/status', validate(S.ticketStatusSchema), tickets.status);

export default router;

// The client portal: proposals, account, and help requests to their company. Clients may submit a response on open proposals.
import { Router } from 'express';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import * as portal from '../services/portal.service.js';
import { listMyLoans } from '../services/loan.service.js';
import { listMySubsidies } from '../services/subsidy.service.js';
import { createReferral, listReferrals, referralForm } from '../services/referral.service.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
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
router.post('/proposals/:id/amc-requests', validate(S.portalAmcRequestSchema), wrap((req) => portal.submitAmcRequest(req.user, req.params.id, req.body)));
router.post('/proposals/:id/response', validate(S.portalProposalResponseSchema), wrap((req) => portal.respondToProposal(req.user, req.params.id, req.body)));
router.get('/proposals/:id/design', wrap((req) => portal.getDesignData(req.user, req.params.id)));
router.get('/loans', wrap((req) => listMyLoans(req.user))); // the loans on their own proposals, with their steps
router.get('/subsidies', wrap((req) => listMySubsidies(req.user))); // the subsidies on their own proposals, with their steps
router.get('/catalog', wrap((req) => portal.viewerCatalog(req.user)));

// "Refer someone": the people this client referred to their company (they become its referral leads), and whether
// each was converted or lost. Nothing else about a lead is shown to the client.
router.get('/referrals', wrap((req) => listReferrals(req.user)));
router.get('/referrals/form', wrap((req) => referralForm(req.user, req.company))); // the company's own lead form
// (the form's fields are the company's, so they are checked against that form in the service, not by a fixed schema)
router.post('/referrals', rateLimit({ name: 'referral', windowMs: 60 * 60 * 1000, max: 20 }), wrap((req) => createReferral(req.user, req.body, req.company)));

// Help & support: the client's own requests to their solar company (never the company's tickets with the platform)
router.get('/tickets', tickets.list);
router.get('/tickets/unread-count', tickets.unread);
router.post('/tickets', uploadClientTicketFiles, validate(S.clientTicketCreateSchema), tickets.create);
router.get('/tickets/:id', tickets.get);
router.post('/tickets/:id/messages', uploadClientTicketFiles, validate(S.ticketMessageSchema), tickets.message);
router.put('/tickets/:id/status', validate(S.ticketStatusSchema), tickets.status);

export default router;

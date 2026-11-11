// Public (no sign-in): a proposal opened from its share link / QR code. Read-only, rate-limited by the caller's IP.
import { Router } from 'express';
import * as google from '../controllers/google.controller.js';
import * as doc from '../controllers/publicDocument.controller.js';
import * as pub from '../services/public.service.js';
import * as free from '../services/freeProposal.service.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';


const router = Router();
const wrap = (fn) => async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').json(await fn(req));
  } catch (err) {
    next(err);
  }
};

router.get('/proposals/:token', wrap((req) => pub.proposal(req.params.token)));
router.get('/proposals/:token/design', wrap((req) => pub.designData(req.params.token)));
router.get('/proposals/:token/catalog', wrap((req) => pub.catalog(req.params.token)));
router.get('/documents/:token', doc.document);

// a free proposal made with the public proposal maker: saved as a lead for the platform admin. Few per visitor, so a tight limit.
const visitor = (req) => ({ ip: req.ip, userAgent: req.get('user-agent'), referrer: req.get('referer') });
router.post('/free-proposals', rateLimit({ name: 'free-proposal', windowMs: 60 * 60 * 1000, max: 10, by: 'ip' }), wrap((req) => free.createFreeProposal(req.body, visitor(req))));
// the visitor keeps editing the proposal they hold the link of (each change of design or wording saves it again)
router.put('/free-proposals/:token', rateLimit({ name: 'free-proposal-edit', windowMs: 60 * 60 * 1000, max: 120, by: 'ip' }), wrap((req) => free.updateFreeProposal(req.params.token, req.body, visitor(req))));
router.get('/free-proposals/:token', wrap((req) => free.getFreeProposal(req.params.token)));

// the 3D ground texture: <img>/WebGL cannot send headers, so the share token rides in the query
router.get('/staticmap', async (req, res, next) => {
  try {
    await pub.assertMapAllowed(String(req.query.st || ''), Number(req.query.lat), Number(req.query.lng));
    await google.staticMap(req, res);
  } catch (err) {
    next(err);
  }
});

export default router;

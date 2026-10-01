// Public (no sign-in): a proposal opened from its share link / QR code. Read-only, rate-limited by the caller's IP.
import { Router } from 'express';
import * as google from '../controllers/google.controller.js';
import * as pub from '../services/public.service.js';

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

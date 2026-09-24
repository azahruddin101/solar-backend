import { Router } from 'express';
import * as auth from '../controllers/auth.controller.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { authenticate } from '../middlewares/auth.middleware.js';

const router = Router();

// per address: stops one machine trying passwords across many accounts (the per-account throttle is in the service)
router.post('/login', rateLimit({ name: 'login', windowMs: 15 * 60 * 1000, max: 60, by: 'ip' }), validate(S.loginSchema), auth.login);
router.get('/me', authenticate, auth.me);
router.put('/me', authenticate, validate(S.profileSchema), auth.updateMe);
router.post('/password', authenticate, validate(S.passwordChangeSchema), auth.changePassword);
router.post('/logout', authenticate, auth.logout);

export default router;

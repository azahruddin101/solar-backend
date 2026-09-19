import { Router } from 'express';
import * as auth from '../controllers/auth.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';

const router = Router();

router.post('/login', auth.login);
router.get('/me', authenticate, auth.me);
router.put('/me', authenticate, auth.updateMe);
router.post('/password', authenticate, auth.changePassword);

export default router;

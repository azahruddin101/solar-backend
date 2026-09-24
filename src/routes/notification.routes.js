import { Router } from 'express';
import * as notifications from '../controllers/notification.controller.js';

const router = Router();

router.get('/', notifications.list);
router.get('/unread-count', notifications.unread);
router.post('/read-all', notifications.readAll);
router.post('/:id/read', notifications.read);

export default router;

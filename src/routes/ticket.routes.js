import { Router } from 'express';
import * as tickets from '../controllers/ticket.controller.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { uploadTicketFiles } from '../middlewares/upload.middleware.js';

const router = Router();

router.get('/', tickets.list);
router.get('/unread-count', tickets.unread);
router.post('/', uploadTicketFiles, validate(S.ticketCreateSchema), tickets.create);
router.get('/:id', tickets.get);
router.post('/:id/messages', uploadTicketFiles, validate(S.ticketMessageSchema), tickets.message);
router.put('/:id/status', validate(S.ticketStatusSchema), tickets.status);

export default router;

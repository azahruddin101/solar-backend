// Client support, company side: the owner, or staff with the "Client support" permission, answer their clients.
// (Separate from /api/tickets, which is the company's support with the platform.)
import { Router } from 'express';
import * as tickets from '../controllers/clientTicket.controller.js';
import { permissionOnly } from '../middlewares/auth.middleware.js';
import { uploadClientTicketFiles } from '../middlewares/upload.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';

const router = Router();
const view = permissionOnly('helpdesk', 'view');
const reply = permissionOnly('helpdesk', 'update');

router.get('/', view, tickets.list);
router.get('/unread-count', view, tickets.unread);
router.post('/', reply, uploadClientTicketFiles, validate(S.clientTicketCreateSchema), tickets.create);
router.get('/:id', view, tickets.get);
router.post('/:id/messages', reply, uploadClientTicketFiles, validate(S.ticketMessageSchema), tickets.message);
router.put('/:id/status', reply, validate(S.ticketStatusSchema), tickets.status);

export default router;

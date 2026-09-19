import { Router } from 'express';
import * as clients from '../controllers/client.controller.js';

const router = Router();

router.get('/', clients.list);
router.post('/', clients.create);
router.put('/:id', clients.update);
router.delete('/:id', clients.remove);

export default router;

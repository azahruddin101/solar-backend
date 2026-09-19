import { Router } from 'express';
import * as designs from '../controllers/design.controller.js';

const router = Router();

router.get('/', designs.list);
router.post('/', designs.create);
router.get('/:id', designs.get);
router.put('/:id', designs.update);
router.delete('/:id', designs.remove);
router.post('/:id/duplicate', designs.duplicate);

export default router;

import { Router } from 'express';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import * as designs from '../controllers/design.controller.js';

const router = Router();

router.get('/', designs.list);
router.post('/', validate(S.designCreateSchema), designs.create);
router.get('/:id/lifecycle', designs.lifecycle);
router.get('/:id', designs.get);
router.put('/:id', designs.update);
router.delete('/:id', designs.remove);
router.post('/:id/duplicate', designs.duplicate);

export default router;

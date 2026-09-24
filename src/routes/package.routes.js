import { Router } from 'express';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { packageController } from '../controllers/package.controller.js';

const router = Router();

router.get('/', packageController.list);
router.post('/', validate(S.packageSchema), packageController.create);
router.get('/:id', packageController.get);
router.put('/:id', validate(S.packageSchema), packageController.update);
router.delete('/:id', packageController.delete);

export default router;

import { Router } from 'express';
import * as roles from '../controllers/role.controller.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';

// Staff roles (named permission sets). Mounted owner-only in routes/index.js: staff can never change roles.
const router = Router();

router.get('/catalog', roles.catalog);
router.get('/', roles.list);
router.post('/', validate(S.roleCreateSchema), roles.create);
router.put('/:id', validate(S.roleUpdateSchema), roles.update);
router.delete('/:id', roles.remove);

export default router;

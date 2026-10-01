import { Router } from 'express';
import { permissionOnly, permissionOnlyAny } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { packageController } from '../controllers/package.controller.js';

const router = Router();
// mounted with withAreaAccess('designs', 'catalog') — reading the package list/detail is part of using
// the designer; creating, changing or deleting a package needs the matching 'catalog' CRUD action.
const view = permissionOnlyAny(['designs', 'catalog'], 'view');
const create = permissionOnly('catalog', 'create');
const update = permissionOnly('catalog', 'update');
const del = permissionOnly('catalog', 'delete');

router.get('/', view, packageController.list);
router.post('/', create, validate(S.packageSchema), packageController.create);
router.get('/:id', view, packageController.get);
router.put('/:id', update, validate(S.packageSchema), packageController.update);
router.delete('/:id', del, packageController.delete);

export default router;

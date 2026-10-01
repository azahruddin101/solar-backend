import { Router } from 'express';
import { permissionOnly, permissionOnlyAny } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { installationChargeService as svc } from '../services/installationCharge.service.js';
import { wrap } from '../utils/wrap.js';

const router = Router();
// mounted with withAreaAccess('designs', 'catalog') — the designer's charge picker only needs to read the
// list; defining/changing the charges themselves needs the matching 'catalog' CRUD action.
const view = permissionOnlyAny(['designs', 'catalog'], 'view');
const create = permissionOnly('catalog', 'create');
const update = permissionOnly('catalog', 'update');
const del = permissionOnly('catalog', 'delete');

router.get('/', view, wrap((req) => svc.list(req.company)));
router.post('/', create, validate(S.installationChargeSchema), wrap((req) => svc.create(req.company, req.body), 201));
router.put('/:id', update, validate(S.installationChargeSchema), wrap((req) => svc.update(req.company, req.params.id, req.body)));
router.delete('/:id', del, wrap((req) => svc.remove(req.company, req.params.id)));

export default router;

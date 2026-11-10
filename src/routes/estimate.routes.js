import { Router } from 'express';
import { permissionOnly } from '../middlewares/auth.middleware.js';
import { estimateService as svc } from '../services/estimate.service.js';
import { wrap } from '../utils/wrap.js';

const router = Router();
// mounted with withAreaAccess('proposals'): estimates are quotes, so they use the Proposals permissions
const view = permissionOnly('proposals', 'view');
const create = permissionOnly('proposals', 'create');
const update = permissionOnly('proposals', 'update');
const del = permissionOnly('proposals', 'delete');

router.get('/', view, wrap((req) => svc.list(req.company, { q: req.query.q })));
router.get('/:id', view, wrap((req) => svc.get(req.company, req.params.id)));
router.post('/', create, wrap((req) => svc.create(req.company, req.user, req.body), 201));
router.post('/:id/converted', create, wrap((req) => svc.markConverted(req.company, req.params.id, req.body?.design)));
router.put('/:id', update, wrap((req) => svc.update(req.company, req.params.id, req.body)));
router.delete('/:id', del, wrap((req) => svc.remove(req.company, req.params.id)));

export default router;

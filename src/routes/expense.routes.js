import { Router } from 'express';
import { permissionOnly, requireRole } from '../middlewares/auth.middleware.js';
import { ROLES } from '../constants/index.js';
import { uploadExpenseBill } from '../middlewares/upload.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as expenses from '../services/expense.service.js';
import * as S from '../validation/schemas.js';
import { wrap } from '../utils/wrap.js';

const router = Router();
const view = permissionOnly('expenses', 'view');
const create = permissionOnly('expenses', 'create');
const update = permissionOnly('expenses', 'update');
const del = permissionOnly('expenses', 'delete');

router.get('/', view, wrap((req) => expenses.overview(req.company, { q: req.query.q })));
router.get('/reasons', view, wrap((req) => expenses.listReasons(req.company)));
router.put('/reasons', requireRole(ROLES.COMPANY), validate(S.expenseReasonsSchema), wrap((req) => expenses.updateReasons(req.company, req.body)));
router.get('/analytics', view, wrap((req) => expenses.analytics(req.company, { months: req.query.months })));
router.get('/design/:designId', view, wrap((req) => expenses.listForDesign(req.company, req.params.designId)));
router.put('/design/:designId/budget', update, validate(S.projectBudgetSchema), wrap((req) => expenses.setBudget(req.company, req.user, req.params.designId, req.body)));
router.delete('/design/:designId/budget', update, wrap(async (req) => { await expenses.removeBudget(req.company, req.params.designId); return { ok: true }; }));
router.post('/design/:designId', create, validate(S.expenseSchema), wrap((req) => expenses.create(req.company, req.user, req.params.designId, req.body), 201));
router.post('/:id/bill', update, uploadExpenseBill, wrap((req) => expenses.attachBill(req.company, req.params.id, req.file), 201));
router.delete('/:id/bill', update, wrap(async (req) => { await expenses.removeBill(req.company, req.params.id); return { ok: true }; }));
router.put('/:id', update, validate(S.expenseSchema.partial()), wrap((req) => expenses.update(req.company, req.params.id, req.body)));
router.delete('/:id', del, wrap(async (req) => { await expenses.remove(req.company, req.params.id); return { ok: true }; }));

export default router;

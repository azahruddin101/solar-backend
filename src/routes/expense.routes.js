import { Router } from 'express';
import { permissionOnly } from '../middlewares/auth.middleware.js';
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
router.get('/analytics', view, wrap((req) => expenses.analytics(req.company, { months: req.query.months })));
router.get('/design/:designId', view, wrap((req) => expenses.listForDesign(req.company, req.params.designId)));
router.put('/design/:designId/budget', update, validate(S.projectBudgetSchema), wrap((req) => expenses.setBudget(req.company, req.user, req.params.designId, req.body)));
router.delete('/design/:designId/budget', update, wrap(async (req) => { await expenses.removeBudget(req.company, req.params.designId); return { ok: true }; }));
router.post('/design/:designId', create, validate(S.expenseSchema), wrap((req) => expenses.create(req.company, req.user, req.params.designId, req.body), 201));
router.put('/:id', update, validate(S.expenseSchema.partial()), wrap((req) => expenses.update(req.company, req.params.id, req.body)));
router.delete('/:id', del, wrap(async (req) => { await expenses.remove(req.company, req.params.id); return { ok: true }; }));

export default router;

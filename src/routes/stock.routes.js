import { Router } from 'express';
import { UNIT_STATUS } from '../constants/index.js';
import { permissionOnly, permissionOnlyAny } from '../middlewares/auth.middleware.js';
import { uploadStockBill } from '../middlewares/upload.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import { supplierService } from '../services/supplier.service.js';
import * as stock from '../services/stock.service.js';
import { wrap } from '../utils/wrap.js';

// Stock is read wherever it is taken out: the catalog (inventory), invoices (finances) and installations (tasks).
const view = permissionOnlyAny(['inventory', 'finances', 'tasks'], 'view');
const create = permissionOnly('inventory', 'create');
const update = permissionOnly('inventory', 'update');
const del = permissionOnly('inventory', 'delete');
// a supplier's purchases carry purchase prices and bills: the same people who may open those bills (fileAccess.service.js)
const viewPurchases = permissionOnlyAny(['inventory', 'finances'], 'view');

/** /api/stock */
export const stockRoutes = Router();
stockRoutes.get('/products/:id/batches', view, wrap((req) => stock.listBatches(req.company, req.params.id, { inStock: req.query.inStock === 'true' })));
stockRoutes.post('/products/:id/batches', create, validate(S.stockReceiveSchema), wrap((req) => stock.receiveStock(req.company, req.params.id, req.body), 201));
stockRoutes.get('/products/:id/units', view, wrap((req) => stock.listUnits(req.company, req.params.id, {
  status: UNIT_STATUS.includes(req.query.status) ? req.query.status : undefined,
  q: typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : undefined,
  page: req.query.page, // paged only when asked: { items, total, page, limit }
  limit: req.query.limit,
})));
stockRoutes.post('/batches/:id/bill', create, uploadStockBill, wrap((req) => stock.attachBatchBill(req.company, req.params.id, req.file), 201));
stockRoutes.put('/batches/:id', update, validate(S.batchUpdateSchema), wrap((req) => stock.updateBatch(req.company, req.params.id, req.body)));
stockRoutes.get('/units', view, wrap((req) => stock.findUnit(req.company, req.query.serial)));
stockRoutes.put('/units/:id/status', update, validate(S.unitStatusSchema), wrap((req) => stock.setUnitStatus(req.company, req.params.id, req.body)));

/** /api/suppliers */
export const supplierRoutes = Router();
supplierRoutes.get('/', view, wrap((req) => supplierService.list(req.company)));
supplierRoutes.get('/:id/purchases', viewPurchases, wrap((req) => supplierService.purchases(req.company, req.params.id)));
supplierRoutes.post('/', create, validate(S.supplierSchema), wrap((req) => supplierService.create(req.company, req.body), 201));
supplierRoutes.put('/:id', update, validate(S.supplierUpdateSchema), wrap((req) => supplierService.update(req.company, req.params.id, req.body)));
supplierRoutes.delete('/:id', del, wrap(async (req) => {
  await supplierService.remove(req.company, req.params.id);
  return { ok: true };
}));

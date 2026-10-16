import { Router } from 'express';
import { permissionOnly, permissionOnlyAny } from '../middlewares/auth.middleware.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import * as catalog from '../controllers/catalog.controller.js';

// /categories and /products are mounted with withAreaAccess('proposals', 'inventory') so the designer (and the
// quick no-3D proposal editor) can read them with just 'proposals:view'; managing the catalog itself needs
// the matching 'inventory' action.
const view = permissionOnlyAny(['proposals', 'inventory'], 'view');
const create = permissionOnly('inventory', 'create');
const update = permissionOnly('inventory', 'update');
const del = permissionOnly('inventory', 'delete');

const crud = (h, createSchema, updateSchema) => {
  const router = Router();
  router.get('/', view, h.list);
  if (h.get) router.get('/:id', view, h.get);
  router.post('/', create, validate(createSchema), h.create);
  router.put('/:id', update, validate(updateSchema), h.update);
  router.delete('/:id', del, h.remove);
  return router;
};

export const categoryRoutes = crud(catalog.categories, S.categorySchema, S.categoryUpdateSchema);
categoryRoutes.post('/reorder', update, catalog.reorderCategories);

export const parentCategoryRoutes = crud(catalog.parentCategories, S.parentCategorySchema, S.parentCategoryUpdateSchema);
parentCategoryRoutes.post('/reorder', update, catalog.reorderParentCategories);

export const productRoutes = crud(catalog.products, S.productSchema, S.productUpdateSchema);
productRoutes.post('/import', create, rateLimit({ name: 'import', windowMs: 10 * 60 * 1000, max: 10 }), catalog.importPanelRows);

export const catalogRoutes = Router();
catalogRoutes.get('/', view, catalog.getDesignerCatalog);

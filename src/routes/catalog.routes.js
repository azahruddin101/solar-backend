import { Router } from 'express';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import * as S from '../validation/schemas.js';
import * as catalog from '../controllers/catalog.controller.js';

const crud = (h, create, update) => {
  const router = Router();
  router.get('/', h.list);
  if (h.get) router.get('/:id', h.get);
  router.post('/', validate(create), h.create);
  router.put('/:id', validate(update), h.update);
  router.delete('/:id', h.remove);
  return router;
};

export const categoryRoutes = crud(catalog.categories, S.categorySchema, S.categoryUpdateSchema);
categoryRoutes.post('/reorder', catalog.reorderCategories);

export const productRoutes = crud(catalog.products, S.productSchema, S.productUpdateSchema);
productRoutes.post('/import', rateLimit({ name: 'import', windowMs: 10 * 60 * 1000, max: 10 }), catalog.importPanelRows);

export const catalogRoutes = Router();
catalogRoutes.get('/', catalog.getDesignerCatalog);

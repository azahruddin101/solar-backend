import { Router } from 'express';
import * as catalog from '../controllers/catalog.controller.js';

const crud = (h) => {
  const router = Router();
  router.get('/', h.list);
  router.post('/', h.create);
  router.put('/:id', h.update);
  router.delete('/:id', h.remove);
  return router;
};

export const panelRoutes = crud(catalog.panels);
panelRoutes.post('/import', catalog.importPanelRows);

export const pillarRoutes = crud(catalog.pillars);

export const catalogRoutes = Router();
catalogRoutes.get('/', catalog.getDesignerCatalog);

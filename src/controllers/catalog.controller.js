import { categoryService, designerCatalog, importPanels, parentCategoryService, productService } from '../services/catalog.service.js';

/** Same four handlers for every catalog resource. */
const handlers = (service) => ({
  list: async (req, res) => res.json(await service.list(req.company, req.query)),
  get: async (req, res) => res.json(await service.get(req.company, req.params.id)),
  create: async (req, res) => res.status(201).json(await service.create(req.company, req.body)),
  update: async (req, res) => res.json(await service.update(req.company, req.params.id, req.body)),
  remove: async (req, res) => {
    await service.remove(req.company, req.params.id);
    res.json({ ok: true });
  },
});

export const categories = handlers(categoryService);
export const products = handlers(productService);
export const parentCategories = { ...handlers(parentCategoryService), get: undefined };

export async function reorderCategories(req, res) {
  res.json(await categoryService.reorder(req.company, req.body?.ids));
}

export async function reorderParentCategories(req, res) {
  res.json(await parentCategoryService.reorder(req.company, req.body?.ids));
}

export async function importPanelRows(req, res) {
  res.json(await importPanels(req.company, req.body?.category, req.body?.items));
}

export async function getDesignerCatalog(req, res) {
  res.set('Cache-Control', 'no-store').json(await designerCatalog(req.company));
}

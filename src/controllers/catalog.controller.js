import { designerCatalog, importPanels, panelService, pillarService } from '../services/catalog.service.js';

/** Same four handlers for panels and poles. */
const handlers = (service) => ({
  list: async (req, res) => res.json(await service.list(req.company)),
  create: async (req, res) => res.status(201).json(await service.create(req.company, req.body)),
  update: async (req, res) => res.json(await service.update(req.company, req.params.id, req.body)),
  remove: async (req, res) => {
    await service.remove(req.company, req.params.id);
    res.json({ ok: true });
  },
});

export const panels = handlers(panelService);
export const pillars = handlers(pillarService);

export async function importPanelRows(req, res) {
  res.json(await importPanels(req.company, req.body?.items));
}

export async function getDesignerCatalog(req, res) {
  res.set('Cache-Control', 'no-store').json(await designerCatalog(req.company));
}

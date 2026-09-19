// A company's product catalog: solar panels and mounting poles.
import { Panel, Pillar } from '../models/index.js';
import { badRequest, forbidden, notFound } from '../utils/HttpError.js';
import { pick } from '../utils/pick.js';
import { objectId } from '../utils/validators.js';

const PANEL_FIELDS = ['brand', 'model', 'watts', 'manufactureYear', 'warrantyYears', 'length', 'width', 'price'];
const PILLAR_FIELDS = ['name', 'shape', 'pricePerFt'];

/** Tenant-scoped CRUD shared by panels and poles. */
function resource(Model, fields, what, sort) {
  const get = async (company, id) => {
    const doc = await Model.findOne({ _id: objectId(id, what), company: company._id });
    if (!doc) throw notFound(what);
    return doc;
  };
  return {
    list: (company) => Model.find({ company: company._id }).sort(sort),
    create: (company, body) => Model.create({ ...pick(body, fields), company: company._id }),
    update: async (company, id, body) => {
      const doc = await get(company, id);
      Object.assign(doc, pick(body, fields));
      return doc.save();
    },
    remove: async (company, id) => {
      await (await get(company, id)).deleteOne();
    },
  };
}

export const panelService = resource(Panel, PANEL_FIELDS, 'Panel', { brand: 1, watts: 1 });
export const pillarService = resource(Pillar, PILLAR_FIELDS, 'Pole', { name: 1 });

/** Bulk import (Excel/CSV parsed in the browser): same brand + model + watt updates, otherwise adds. */
export async function importPanels(company, items) {
  if (!company.features.excelImport) throw forbidden('Excel import is not enabled for your company');
  if (!Array.isArray(items) || !items.length) throw badRequest('Nothing to import');
  const keyOf = (p) => `${p.brand}|${p.model || ''}|${Number(p.watts)}`.toLowerCase();
  const byKey = new Map((await Panel.find({ company: company._id })).map((p) => [keyOf(p), p]));
  let added = 0;
  let updated = 0;
  for (const raw of items.slice(0, 1000)) {
    const item = pick(raw, PANEL_FIELDS);
    for (const k of Object.keys(item)) if (item[k] === null || item[k] === '') delete item[k];
    const doc = byKey.get(keyOf(item));
    if (doc) {
      Object.assign(doc, item);
      await doc.save();
      updated++;
    } else {
      byKey.set(keyOf(item), await Panel.create({ ...item, company: company._id }));
      added++;
    }
  }
  return { added, updated };
}

/** What the designer consumes: products plus the company's pricing settings. */
export async function designerCatalog(company) {
  const [panels, pillars] = await Promise.all([Panel.find({ company: company._id }).sort({ watts: 1 }), Pillar.find({ company: company._id })]);
  const { currency, tariff, otherCostPerKw } = company;
  return { currency, tariff, otherCostPerKw, panels, pillars };
}

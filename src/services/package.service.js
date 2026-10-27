import mongoose from 'mongoose';
import { Package, Product } from '../models/index.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { pick } from '../utils/pick.js';
import { capFirst } from '../utils/text.js';
import { objectId } from '../utils/validators.js';
import { stockSummary } from './stock.service.js';

const ALLOWED_FIELDS = ['name', 'kw', 'price', 'description', 'items'];

async function assertPackageItemsOwnedByCompany(company, items) {
  if (!items?.length) return;
  const ids = [...new Set(items.map((it) => String(it.productId)).filter(Boolean))];
  if (!ids.length) return;
  const owned = await Product.countDocuments({
    _id: { $in: ids.map((id) => objectId(id, 'Product')) },
    company: company._id,
  });
  if (owned !== ids.length) {
    throw badRequest('Each package line must use a product from your company catalog only');
  }
}

function cleanPackageBody(body) {
  const data = pick(body, ALLOWED_FIELDS);
  if (!String(data.name ?? '').trim()) throw badRequest('Package name is required');
  if (data.price === undefined || isNaN(Number(data.price)) || Number(data.price) < 0) {
    throw badRequest('A valid package price is required');
  }
  data.price = Number(data.price);
  if (data.kw !== undefined) data.kw = Number(data.kw) || 0;

  if (Array.isArray(data.items)) {
    // Only keep items that reference an actual product
    data.items = data.items
      .filter((it) => it.productId)
      .map((it) => ({
        productId: it.productId,
        qty: Math.max(0, Number(it.qty) || 1),
        unit: capFirst(it.unit) || 'Nos',
      }));
  }
  return data;
}

/** Infer itemType from product type and category name */
function inferItemType(type, categoryName) {
  if (type === 'panels') return 'panel';
  if (type === 'poles') return 'poles';
  const lower = (categoryName || '').toLowerCase();
  if (lower.includes('inverter')) return 'inverter';
  if (lower.includes('wire') || lower.includes('cabling') || lower.includes('cable')) return 'wire';
  if (lower.includes('earthing')) return 'earthing';
  if (lower.includes('acdb')) return 'acdb';
  if (lower.includes('dcdb')) return 'dcdb';
  return 'other';
}

/**
 * Aggregation pipeline that populates each package's items with full product details
 * (name, brand, model, watts, specs, itemType) via $lookup on products + categories.
 */
function buildPackagePipeline(matchStage, sortStage = { $sort: { createdAt: -1 } }) {
  return [
    matchStage,
    sortStage,
    // ── Lookup products referenced in items (same company only) ───────────
    {
      $lookup: {
        from: 'products',
        let: { itemIds: '$items.productId', pkgCompany: '$company' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $in: ['$_id', '$$itemIds'] }, { $eq: ['$company', '$$pkgCompany'] }],
              },
            },
          },
          // For each product, also fetch its category (to infer itemType)
          {
            $lookup: {
              from: 'categories',
              localField: 'category',
              foreignField: '_id',
              as: '_cat',
            },
          },
          // … and that category's parent category (for the grouped bill of materials)
          {
            $lookup: {
              from: 'parentcategories',
              localField: '_cat.parent',
              foreignField: '_id',
              as: '_parent',
            },
          },
          {
            $addFields: {
              _catName: {
                $ifNull: [{ $toLower: { $arrayElemAt: ['$_cat.name', 0] } }, ''],
              },
              _catLabel: { $ifNull: [{ $arrayElemAt: ['$_cat.name', 0] }, ''] },
              _parentId: { $ifNull: [{ $toString: { $arrayElemAt: ['$_parent._id', 0] } }, ''] },
              _parentName: { $ifNull: [{ $arrayElemAt: ['$_parent.name', 0] }, ''] },
              _parentOrder: { $ifNull: [{ $arrayElemAt: ['$_parent.position', 0] }, 0] },
              _catAttrs: { $ifNull: [{ $arrayElemAt: ['$_cat.attributes', 0] }, []] },
            },
          },
          { $project: { _cat: 0, _parent: 0 } },
        ],
        as: '_products',
      },
    },
    // ── Map each item to its resolved product ────────────────────────────────
    {
      $addFields: {
        items: {
          $map: {
            input: { $ifNull: ['$items', []] },
            as: 'it',
            in: {
              $let: {
                vars: {
                  prod: {
                    $first: {
                      $filter: {
                        input: '$_products',
                        cond: { $eq: ['$$this._id', '$$it.productId'] },
                      },
                    },
                  },
                },
                in: {
                  productId: { $toString: '$$it.productId' },
                  qty: '$$it.qty',
                  unit: '$$it.unit',
                  name: { $ifNull: ['$$prod.name', ''] },
                  brand: { $ifNull: ['$$prod.brand', ''] },
                  model: { $ifNull: ['$$prod.model', ''] },
                  watts: { $ifNull: ['$$prod.watts', 0] },
                  hsnCode: { $ifNull: ['$$prod.hsnCode', ''] },
                  gstPercent: { $ifNull: ['$$prod.gstPercent', 0] },
                  type: { $ifNull: ['$$prod.type', ''] },
                  categoryName: { $ifNull: ['$$prod._catName', ''] },
                  category: { $ifNull: ['$$prod._catLabel', ''] },
                  parentId: { $ifNull: ['$$prod._parentId', ''] },
                  parentName: { $ifNull: ['$$prod._parentName', ''] },
                  parentOrder: { $ifNull: ['$$prod._parentOrder', 0] },
                  _attrs: { $ifNull: ['$$prod.attributes', {}] },
                  _attrDefs: { $ifNull: ['$$prod._catAttrs', []] },
                  _description: { $ifNull: ['$$prod.description', ''] },
                },
              },
            },
          },
        },
        id: { $toString: '$_id' },
      },
    },
    { $project: { _products: 0 } },
  ];
}

/** "Efficiency (%): 21.5, Cell type: TOPCon" from the product's attributes in its category's order, else its description. */
function specLine(attrs, defs, description) {
  const shown = [...(defs || [])]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .filter((d) => attrs?.[d.key] !== undefined && attrs[d.key] !== '')
    .map((d) => `${d.label}: ${d.dataType === 'boolean' ? (attrs[d.key] ? 'Yes' : 'No') : attrs[d.key]}`);
  return shown.length ? shown.join(', ') : description;
}

/** Add itemType, the spec line and each product's current selling price (from its batches; done in JS after aggregation) */
async function enrichItems(company, pkgs) {
  const ids = [...new Set(pkgs.flatMap((pkg) => (pkg.items || []).map((it) => it.productId)).filter(Boolean))];
  const stock = await stockSummary(company._id, ids.map((id) => new mongoose.Types.ObjectId(id)));
  return pkgs.map((pkg) => ({
    ...pkg,
    id: pkg.id || String(pkg._id),
    items: (pkg.items || []).map(({ _attrs, _attrDefs, _description, ...it }) => ({
      ...it,
      price: stock.get(it.productId)?.price || 0,
      spec: specLine(_attrs, _attrDefs, _description),
      itemType: inferItemType(it.type, it.categoryName),
    })),
  }));
}

export const packageService = {
  list: async (company) => {
    const raw = await Package.aggregate(
      buildPackagePipeline(
        { $match: { company: new mongoose.Types.ObjectId(company._id) } },
        { $sort: { createdAt: -1 } },
      ),
    );
    return enrichItems(company, raw);
  },

  get: async (company, id) => {
    const raw = await Package.aggregate(
      buildPackagePipeline({
        $match: {
          _id: objectId(id, 'Package'),
          company: new mongoose.Types.ObjectId(company._id),
        },
      }),
    );
    if (!raw.length) throw notFound('Package');
    return (await enrichItems(company, raw))[0];
  },

  create: async (company, body) => {
    const data = cleanPackageBody(body);
    await assertPackageItemsOwnedByCompany(company, data.items);
    const pkg = await new Package({ ...data, company: company._id }).save();
    return packageService.get(company, pkg._id);
  },

  update: async (company, id, body) => {
    const pkg = await Package.findOne({ _id: objectId(id, 'Package'), company: company._id });
    if (!pkg) throw notFound('Package');
    const data = cleanPackageBody(body);
    await assertPackageItemsOwnedByCompany(company, data.items);
    Object.assign(pkg, data);
    await pkg.save();
    return packageService.get(company, pkg._id);
  },

  delete: async (company, id) => {
    const pkg = await Package.findOneAndDelete({ _id: objectId(id, 'Package'), company: company._id });
    if (!pkg) throw notFound('Package');
    return { ok: true };
  },

  // Exported for use in catalog.service.js
  buildPackagePipeline,
  enrichItems,
  inferItemType,
};

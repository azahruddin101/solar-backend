import mongoose from 'mongoose';
import { Package, Product } from '../models/index.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { pick } from '../utils/pick.js';
import { capFirst } from '../utils/text.js';
import { objectId } from '../utils/validators.js';

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
          {
            $addFields: {
              _catName: {
                $ifNull: [{ $toLower: { $arrayElemAt: ['$_cat.name', 0] } }, ''],
              },
              // Flatten specs array to "key: value, key: value" string
              _specStr: {
                $cond: {
                  if: { $gt: [{ $size: { $ifNull: ['$specs', []] } }, 0] },
                  then: {
                    $reduce: {
                      input: '$specs',
                      initialValue: '',
                      in: {
                        $cond: [
                          { $eq: ['$$value', ''] },
                          { $concat: ['$$this.key', ': ', '$$this.value'] },
                          { $concat: ['$$value', ', ', '$$this.key', ': ', '$$this.value'] },
                        ],
                      },
                    },
                  },
                  else: { $ifNull: ['$description', ''] },
                },
              },
            },
          },
          { $project: { _cat: 0 } },
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
                  price: { $ifNull: ['$$prod.price', 0] },
                  type: { $ifNull: ['$$prod.type', ''] },
                  categoryName: { $ifNull: ['$$prod._catName', ''] },
                  spec: { $ifNull: ['$$prod._specStr', ''] },
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

/** Add itemType to each item (done in JS after aggregation) */
function enrichItems(pkgs) {
  return pkgs.map((pkg) => ({
    ...pkg,
    id: pkg.id || String(pkg._id),
    items: (pkg.items || []).map((it) => ({
      ...it,
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
    return enrichItems(raw);
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
    return enrichItems(raw)[0];
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

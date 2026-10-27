// A company's product catalog: categories the company defines, and the products in them. Each category defines the
// attributes its products carry (attribute.service.js). A category can be marked as holding solar panels or poles;
// its products are then picked up by the designer, so they also carry watt + size / shape. Prices and stock are not
// on the product: they come from its batches (stock.service.js).
import { DEFAULT_CATEGORIES, DEFAULT_PANELS, DEFAULT_PILLARS, DEFAULT_PRODUCT_UNITS, PRODUCT_TYPES } from '../constants/index.js';
import { Batch, Category, Package, ParentCategory, Product, Supplier } from '../models/index.js';
import { seedParentCategories } from '../migrations/parentCategory.migration.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/HttpError.js';
import { pick } from '../utils/pick.js';
import { capFirst } from '../utils/text.js';
import { objectId } from '../utils/validators.js';
import { attributeKey, cleanAttributeDefs, textAttributes, validateAttributes } from './attribute.service.js';
import { stockSummary } from './stock.service.js';
import { deleteFile } from './storage.service.js';

const COMMON = ['name', 'brand', 'model', 'sku', 'hsnCode', 'gstPercent', 'warrantyMonths', 'reorderLevel', 'isSerialized', 'description'];
const FIELDS = {
  general: [...COMMON, 'unit'],
  panels: [...COMMON, 'unit', 'watts', 'length', 'width'],
  poles: [...COMMON, 'unit', 'shape'],
};

const TYPED = ['watts', 'length', 'width', 'shape'];

function productUnitsList(company) {
  const raw = company?.productUnits;
  const list = Array.isArray(raw) && raw.length ? raw : DEFAULT_PRODUCT_UNITS;
  return [...new Set(list.map((u) => String(u).trim()).filter(Boolean))];
}

function resolveProductUnit(company, unit) {
  const allowed = productUnitsList(company);
  if (!allowed.length) throw badRequest('Add at least one product unit under Product units');
  const trimmed = String(unit ?? '').trim();
  if (!trimmed) return allowed[0];
  const match = allowed.find((a) => a.toLowerCase() === trimmed.toLowerCase());
  if (!match) throw badRequest(`“${trimmed}” is not in your product units. Add it on the Product units page or choose another.`);
  return match;
}

/** Apply the body to a product of its category's type and check what that type needs. */
function applyProduct(product, category, body, company) {
  product.category = category._id;
  product.type = category.type;
  const { type } = product;
  Object.assign(product, pick(body, FIELDS[type]));
  // older clients send the warranty in years
  if (body?.warrantyMonths === undefined && body?.warrantyYears != null && body.warrantyYears !== '') product.warrantyMonths = Math.round(Number(body.warrantyYears) * 12);
  for (const field of TYPED) if (!FIELDS[type].includes(field)) product[field] = undefined; // left over from a previous type
  // checked on every create and edit: a category that gained a required attribute asks for it when the product is next saved
  product.attributes = validateAttributes(category.attributes, body?.attributes, product.isNew ? {} : product.attributes);
  product.markModified('attributes');
  product.unit = resolveProductUnit(company, product.unit);
  if (type === 'panels') {
    // imported panels come with brand + model only; those name the product
    if (!String(product.name ?? '').trim()) product.name = `${product.brand} ${product.model || ''}`.trim();
    for (const [field, label] of [['watts', 'Watt'], ['length', 'Length'], ['width', 'Width']]) if (!(Number(product[field]) > 0)) throw badRequest(`${label} is required`);
  }
  if (type === 'poles') product.shape ||= 'square';
  return product;
}

/* ───────────── categories ───────────── */

async function getCategory(company, id) {
  const category = await Category.findOne({ _id: objectId(id, 'Category'), company: company._id });
  if (!category) throw notFound('Category');
  return category;
}

function categoryIconFilename(iconUrl) {
  if (!iconUrl) return '';
  return String(iconUrl).replace(/^\/uploads\//, '').trim();
}

async function clearCategoryIcon(category) {
  const name = categoryIconFilename(category.icon);
  category.icon = '';
  if (name) await deleteFile(name).catch(() => {});
}

async function categoryWithProductCount(company, category) {
  const n = await Product.countDocuments({ company: company._id, category: category._id });
  return { ...category.toJSON(), products: n };
}

async function applyCategory(company, category, body) {
  Object.assign(category, pick(body, ['name', 'description']));
  if (body?.type !== undefined) {
    if (!PRODUCT_TYPES.includes(body.type)) throw badRequest('Invalid category type');
    category.type = body.type;
  }
  const retyped = !category.isNew && category.isModified('type');
  const name = String(category.name ?? '').trim();
  if (!name) throw badRequest('Category name is required');
  const twin = await Category.findOne({ company: company._id, _id: { $ne: category._id }, name }).collation({ locale: 'en', strength: 2 });
  if (twin) throw conflict('You already have a category with that name');
  if (body?.parent !== undefined) category.parent = body.parent ? (await getParentCategory(company, body.parent))._id : null;
  // existing products keep their values when the definitions change (see validateAttributes)
  if (body?.attributes !== undefined) category.attributes = cleanAttributeDefs(body.attributes);
  await category.save();
  // the products follow their category; panels still missing a watt or size stay out of the designer until edited
  if (retyped) await Product.updateMany({ company: company._id, category: category._id }, { type: category.type });
  return category;
}

/* ───────────── parent categories ───────────── */

async function getParentCategory(company, id) {
  const parent = await ParentCategory.findOne({ _id: objectId(id, 'Parent category'), company: company._id });
  if (!parent) throw notFound('Parent category');
  return parent;
}

async function applyParentCategory(company, parent, body) {
  Object.assign(parent, pick(body, ['name', 'description']));
  const name = String(parent.name ?? '').trim();
  if (!name) throw badRequest('Parent category name is required');
  const twin = await ParentCategory.findOne({ company: company._id, _id: { $ne: parent._id }, name }).collation({ locale: 'en', strength: 2 });
  if (twin) throw conflict('You already have a parent category with that name');
  return parent.save();
}

export const parentCategoryService = {
  /** In the company's own order; each with the number of categories filed under it. */
  list: async (company) => {
    const [parents, counts] = await Promise.all([
      ParentCategory.find({ company: company._id }).sort({ position: 1, createdAt: 1, _id: 1 }),
      Category.aggregate([{ $match: { company: company._id, parent: { $ne: null } } }, { $group: { _id: '$parent', n: { $sum: 1 } } }]),
    ]);
    const categories = new Map(counts.map((c) => [String(c._id), c.n]));
    return parents.map((p) => ({ ...p.toJSON(), categories: categories.get(p.id) || 0 }));
  },
  create: async (company, body) => {
    if ((await ParentCategory.countDocuments({ company: company._id })) >= 20) throw badRequest('You can have up to 20 parent categories');
    const last = await ParentCategory.findOne({ company: company._id }).sort({ position: -1 });
    return { ...(await applyParentCategory(company, new ParentCategory({ company: company._id, position: (last?.position || 0) + 1 }), body)).toJSON(), categories: 0 };
  },
  update: async (company, id, body) => applyParentCategory(company, await getParentCategory(company, id), body),
  /** `ids` is the full list of the company's parent category ids in their new order. */
  reorder: async (company, ids) => {
    if (!Array.isArray(ids) || !ids.length) throw badRequest('Nothing to reorder');
    await ParentCategory.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: objectId(id, 'Parent category'), company: company._id }, update: { position: i + 1 } } })));
    return parentCategoryService.list(company);
  },
  /** Deleting a parent category keeps its categories and their products: they only lose the grouping. */
  remove: async (company, id) => {
    const parent = await getParentCategory(company, id);
    await Category.updateMany({ company: company._id, parent: parent._id }, { parent: null });
    await parent.deleteOne();
  },
};

export const categoryService = {
  /** In the company's own order (new ones last); each with its product count. */
  list: async (company) => {
    const [categories, counts] = await Promise.all([
      Category.find({ company: company._id }).sort({ position: 1, createdAt: 1, _id: 1 }),
      Product.aggregate([{ $match: { company: company._id } }, { $group: { _id: '$category', n: { $sum: 1 } } }]),
    ]);
    const products = new Map(counts.map((c) => [String(c._id), c.n]));
    return categories.map((c) => ({ ...c.toJSON(), products: products.get(c.id) || 0 }));
  },
  create: async (company, body) => {
    if ((await Category.countDocuments({ company: company._id })) >= 50) throw badRequest('You can have up to 50 categories');
    const last = await Category.findOne({ company: company._id }).sort({ position: -1 });
    return { ...(await applyCategory(company, new Category({ company: company._id, position: (last?.position || 0) + 1 }), body)).toJSON(), products: 0 };
  },
  update: async (company, id, body) => applyCategory(company, await getCategory(company, id), body),
  /** `ids` is the full list of the company's category ids in their new order. */
  reorder: async (company, ids) => {
    if (!Array.isArray(ids) || !ids.length) throw badRequest('Nothing to reorder');
    await Category.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: objectId(id, 'Category'), company: company._id }, update: { position: i + 1 } } })));
    return categoryService.list(company);
  },
  /** Deleting a category also deletes its products — unless one of them has stock history (batches). */
  remove: async (company, id) => {
    const category = await getCategory(company, id);
    const products = await Product.find({ company: company._id, category: category._id }).select('documents');
    if (await Batch.exists({ company: company._id, product: { $in: products.map((p) => p._id) } })) throw conflict('Products in this category have stock received. Move them to another category first');
    await Product.deleteMany({ company: company._id, category: category._id });
    await deleteProductFiles(products);
    await clearCategoryIcon(category);
    await Supplier.updateMany({ company: company._id, categories: category._id }, { $pull: { categories: category._id } });
    await category.deleteOne();
  },
  setIcon: async (company, id, file) => {
    if (!file?.filename) throw badRequest('Choose an image to upload');
    const category = await getCategory(company, id);
    const old = categoryIconFilename(category.icon);
    category.icon = `/uploads/${file.filename}`;
    await category.save();
    if (old && old !== file.filename) await deleteFile(old).catch(() => {});
    return categoryWithProductCount(company, category);
  },
  removeIcon: async (company, id) => {
    const category = await getCategory(company, id);
    await clearCategoryIcon(category);
    await category.save();
    return categoryWithProductCount(company, category);
  },
};

/* ───────────── products ───────────── */

export const MAX_PRODUCT_DOCUMENTS = 10;

/** Removes the stored PDFs of products that are being deleted. */
async function deleteProductFiles(products) {
  const names = products.flatMap((p) => (p.documents || []).map((d) => String(d.url).replace(/^\/uploads\//, '')));
  await Promise.all(names.map((n) => deleteFile(n).catch(() => {})));
}

async function getProduct(company, id) {
  const product = await Product.findOne({ _id: objectId(id, 'Product'), company: company._id });
  if (!product) throw notFound('Product');
  return product;
}

/**
 * Products as the API returns them: with `stock` (sum of the batches' remaining quantity), `lowStock`, `hasBatches`
 * (stock was ever received: serial tracking can no longer change), and `price` —
 * read-only, the current selling price from the batches (stockSummary), so the designer and proposals keep working.
 */
async function withStock(company, products) {
  const list = Array.isArray(products) ? products : [products];
  const summary = await stockSummary(company._id, list.map((p) => p._id));
  const out = list.map((p) => {
    const { stock = 0, price = 0 } = summary.get(String(p._id)) || {};
    return { ...p.toJSON(), stock, price, lowStock: stock <= (p.reorderLevel || 0), hasBatches: summary.has(String(p._id)) };
  });
  return Array.isArray(products) ? out : out[0];
}

export const productService = {
  list: async (company, { category } = {}) => withStock(company, await Product.find({ company: company._id, ...(category ? { category: objectId(category, 'Category') } : {}) }).sort({ name: 1 })),
  get: async (company, id) => {
    const product = await getProduct(company, id);
    await product.populate('category');
    return withStock(company, product);
  },
  create: async (company, body) => {
    const category = await getCategory(company, body?.category);
    return withStock(company, await applyProduct(new Product({ company: company._id }), category, body, company).save());
  },
  /** A product can move to any of the company's categories; it takes on that category's type. */
  update: async (company, id, body) => {
    const product = await getProduct(company, id);
    if (body?.isSerialized !== undefined && Boolean(body.isSerialized) !== product.isSerialized && (await Batch.exists({ product: product._id }))) {
      throw conflict('Stock of this product has already been received, so its serial-number tracking can’t be changed');
    }
    await applyProduct(product, await getCategory(company, body?.category ?? product.category), body, company).save();
    await product.populate('category');
    return withStock(company, product);
  },
  /** A product with stock history (batches, serial units, invoices that copied them) can't be deleted. */
  remove: async (company, id) => {
    const product = await getProduct(company, id);
    if (await Batch.exists({ product: product._id })) throw conflict('This product has stock received, so it can’t be deleted');
    await product.deleteOne();
    await deleteProductFiles([product]);
  },
  /** Keeps an uploaded PDF with the product (the file is already stored by uploadProductDocument). */
  addDocument: async (company, id, file) => {
    if (!file?.filename) throw badRequest('Choose a PDF to upload');
    let product;
    try {
      product = await getProduct(company, id);
      if (product.documents.length >= MAX_PRODUCT_DOCUMENTS) throw badRequest(`A product can keep up to ${MAX_PRODUCT_DOCUMENTS} PDFs. Remove one first`);
      const name = String(file.originalname || '').replace(/\.pdf$/i, '').trim().slice(0, 200) || 'Document';
      product.documents.push({ name, url: `/uploads/${file.filename}`, size: file.size });
      await product.save();
    } catch (e) {
      await deleteFile(file.filename).catch(() => {}); // not kept: don't leave the stored file behind
      throw e;
    }
    await product.populate('category');
    return withStock(company, product);
  },
  removeDocument: async (company, id, docId) => {
    const product = await getProduct(company, id);
    const doc = product.documents.id(docId);
    if (!doc) throw notFound('Document');
    const filename = doc.url.replace(/^\/uploads\//, '');
    doc.deleteOne();
    await product.save();
    await deleteFile(filename).catch(() => {});
    await product.populate('category');
    return withStock(company, product);
  },
};

/** Bulk import into a solar panel category (Excel/CSV parsed in the browser): same brand + model + watt updates, otherwise adds. Prices and quantities in the sheet are ignored: stock is received as batches. */
export async function importPanels(company, categoryId, items) {
  if (!company.features.excelImport) throw forbidden('Excel import is not enabled for your company');
  const category = await getCategory(company, categoryId);
  if (category.type !== 'panels') throw badRequest('Panels can only be imported into a solar panel category');
  if (!Array.isArray(items) || !items.length) throw badRequest('Nothing to import');
  const keyOf = (p) => `${p.brand}|${p.model || ''}|${Number(p.watts)}`.toLowerCase();
  const byKey = new Map((await Product.find({ company: company._id, category: category._id, type: 'panels' })).map((p) => [keyOf(p), p]));
  let added = 0;
  let updated = 0;
  for (const raw of items.slice(0, 1000)) {
    const item = pick(raw, [...FIELDS.panels.filter((f) => f !== 'name'), 'warrantyYears', 'attributes']); // prices and stock come in as batches, not here
    for (const k of Object.keys(item)) if (item[k] === null || item[k] === '') delete item[k];
    const doc = byKey.get(keyOf(item));
    if (doc) {
      await applyProduct(doc, category, item, company).save();
      updated++;
    } else {
      const created = await applyProduct(new Product({ company: company._id }), category, { length: 1.9, width: 1.05, ...item }, company).save();
      byKey.set(keyOf(created), created);
      added++;
    }
  }
  return { added, updated };
}

/** What the designer consumes: panels, poles, categories with products, and pricing settings.
 * Packages are served separately from GET /api/packages. */
export async function designerCatalog(company) {
  const [categories, products, parents, stock] = await Promise.all([
    Category.find({ company: company._id }).sort({ position: 1, createdAt: 1 }),
    Product.find({ company: company._id }).sort({ name: 1 }),
    ParentCategory.find({ company: company._id }).sort({ position: 1, createdAt: 1, _id: 1 }),
    stockSummary(company._id),
  ]);
  // the price a proposal quotes: the retail price of the batch FIFO sells next (see stockSummary)
  const priceOf = (p) => stock.get(p.id)?.price || 0;

  // the parent category of every category, for the grouped bill of materials
  const parentById = new Map(parents.map((p, i) => [p.id, { parentId: p.id, parentName: p.name, parentOrder: i + 1 }]));
  const NO_PARENT = { parentId: '', parentName: '', parentOrder: 0 };
  const groupByCategory = new Map(categories.map((c) => [c.id, { categoryName: c.name, ...(parentById.get(String(c.parent || '')) || NO_PARENT) }]));
  const groupOf = (product) => groupByCategory.get(String(product.category)) || { categoryName: '', ...NO_PARENT };

  const { currency, tariff, otherCostPerKw } = company;

  // Group products by category ID
  const productsByCat = new Map();
  for (const p of products) {
    const cid = String(p.category);
    if (!productsByCat.has(cid)) productsByCat.set(cid, []);
    productsByCat.get(cid).push({
      id: p.id,
      name: p.name,
      brand: p.brand || '',
      model: p.model || '',
      price: priceOf(p),
      stock: stock.get(p.id)?.stock || 0,
      unit: capFirst(p.unit) || 'Nos',
      description: p.description || '',
      hsnCode: p.hsnCode || '',
      gstPercent: p.gstPercent != null ? Number(p.gstPercent) : undefined,
    });
  }

  // Material categories: all categories other than panels and poles that have products added
  const materialCategories = categories
    .filter((cat) => cat.type !== 'panels' && cat.type !== 'poles')
    .map((cat) => ({
      id: cat.id,
      name: cat.name,
      description: cat.description || '',
      ...pick(groupByCategory.get(cat.id), ['parentId', 'parentName', 'parentOrder']),
      products: productsByCat.get(cat.id) || [],
    }))
    .filter((cat) => cat.products.length > 0);

  return {
    currency,
    tariff,
    otherCostPerKw,
    panels: products
      .filter((p) => p.type === 'panels' && p.watts > 0 && p.length > 0 && p.width > 0)
      .map((p) => ({ id: p.id, brand: p.brand || p.name, model: p.brand ? p.model : '', ...pick(p, ['watts', 'length', 'width', 'warrantyMonths', 'hsnCode', 'gstPercent']), price: priceOf(p), manufactureYear: stock.get(p.id)?.mfgYear || null, warrantyYears: Math.floor((p.warrantyMonths || 0) / 12), ...groupOf(p) })),
    pillars: products
      .filter((p) => p.type === 'poles')
      .map((p) => ({ id: p.id, name: p.name, shape: p.shape, pricePerFt: priceOf(p), ...pick(p, ['hsnCode', 'gstPercent']), ...groupOf(p) })),
    parentCategories: parents.map((p, i) => ({ id: p.id, name: p.name, order: i + 1 })),
    materialCategories,
  };
}

/* ───────────── starter catalog ───────────── */

/** Categories whose products are tracked per physical unit when a starter catalog creates them. */
export const SERIALIZED_BY_DEFAULT = /panel|module|inverter|batter/i;
export const OPENING_SUPPLIER = 'Opening stock';

/** The supplier that opening-stock batches (stock entered before purchases were recorded) are filed under. */
export function openingSupplier(companyId) {
  return Supplier.findOneAndUpdate(
    { company: companyId, name: OPENING_SUPPLIER },
    { $setOnInsert: { company: companyId, name: OPENING_SUPPLIER, notes: 'Stock and prices entered before purchases were recorded' } },
    { upsert: true, returnDocument: 'after' },
  );
}

/**
 * Starter product literals in a flat shape (price, quantity, warrantyYears, manufactureYear, specs) → products with
 * attributes, each with one opening batch that holds its price as base, wholesale and retail price (and its
 * quantity, unless it is tracked by serial number: those units need real serials, so the batch starts empty).
 */
export async function insertStarterProducts(companyId, items, categoryById) {
  const supplier = await openingSupplier(companyId);
  for (const { price = 0, quantity = 0, warrantyYears = 0, manufactureYear = null, specs = [], ...fields } of items) {
    const category = categoryById.get(String(fields.category));
    const product = await Product.create({
      ...fields,
      isSerialized: fields.isSerialized ?? SERIALIZED_BY_DEFAULT.test(category?.name || ''),
      warrantyMonths: Math.round(warrantyYears * 12),
      attributes: Object.fromEntries(specs.map((sp) => [attributeKey(sp.key), sp.value])),
    });
    const qty = product.isSerialized ? 0 : quantity;
    await Batch.create({ company: companyId, product: product._id, supplier: supplier._id, mfgYear: manufactureYear, qtyReceived: qty, qtyRemaining: qty, purchasePrice: 0, basePrice: price, wholesalePrice: price, retailPrice: price, note: OPENING_SUPPLIER });
  }
}

/** Starter catalog for a new company: all required categories populated with real solar equipment, plus turnkey packages. */
export async function createStarterCatalog(companyId, { panels = DEFAULT_PANELS, pillars = DEFAULT_PILLARS } = {}) {
  const categories = await Category.insertMany(DEFAULT_CATEGORIES.map(({ specKeys, ...c }, i) => ({ ...c, attributes: textAttributes(specKeys), position: i + 1, company: companyId })));

  const catMap = new Map(categories.map((c) => [c.name, c._id]));
  const catTypeMap = new Map(categories.map((c) => [c.type, c._id]));

  const getCatId = (name, type) => catMap.get(name) || (type ? catTypeMap.get(type) : null) || categories[0]._id;

  const productsToInsert = [
    // 1. Solar Panels
    ...panels.map((p) => ({
      company: companyId,
      category: getCatId('Solar panels', 'panels'),
      type: 'panels',
      name: `${p.brand} ${p.model || ''}`.trim(),
      brand: p.brand,
      model: p.model || '',
      watts: p.watts,
      length: p.length || 2.28,
      width: p.width || 1.13,
      price: p.price,
      manufactureYear: p.manufactureYear || 2026,
      warrantyYears: p.warrantyYears || 25,
      unit: 'Panel',
      specs: [
        { key: 'Cell type', value: 'Mono PERC Half-cut' },
        { key: 'Efficiency (%)', value: '21.5' },
      ],
    })),

    // 2. Mounting Poles / Pillars
    ...pillars.map(({ pricePerFt, ...p }) => ({
      company: companyId,
      category: getCatId('Poles / pillars', 'poles'),
      type: 'poles',
      name: p.name,
      shape: p.shape || 'square',
      price: pricePerFt,
      unit: 'Foot',
      specs: [
        { key: 'Material', value: 'Hot Dip Galvanized (HDG) Steel' },
        { key: 'Coating', value: '80 Micron Zinc Coating' },
      ],
    })),

    // 3. Inverters
    {
      company: companyId,
      category: getCatId('Inverters'),
      type: 'general',
      name: 'Growatt MIN 5000TL-X Single Phase Inverter',
      brand: 'Growatt',
      model: 'MIN 5000TL-X',
      sku: 'INV-GW-5K',
      price: 48000,
      warrantyYears: 5,
      unit: 'Piece',
      description: '5 kW Single-phase on-grid solar string inverter with dual MPPT and Wi-Fi monitoring.',
      specs: [
        { key: 'Capacity (kW)', value: '5.0' },
        { key: 'MPPT count', value: '2' },
        { key: 'Phase', value: 'Single Phase (230V)' },
        { key: 'Max Efficiency (%)', value: '98.4' },
        { key: 'Wi-Fi', value: 'Built-in Wi-Fi Dongle' },
      ],
    },
    {
      company: companyId,
      category: getCatId('Inverters'),
      type: 'general',
      name: 'Sungrow SG10RT 10kW Three Phase Inverter',
      brand: 'Sungrow',
      model: 'SG10RT',
      sku: 'INV-SG-10K',
      price: 88000,
      warrantyYears: 10,
      unit: 'Piece',
      description: '10 kW Three-phase grid-tied inverter with smart PID recovery and IV curve scan.',
      specs: [
        { key: 'Capacity (kW)', value: '10.0' },
        { key: 'MPPT count', value: '2' },
        { key: 'Phase', value: 'Three Phase (415V)' },
        { key: 'Max Efficiency (%)', value: '98.5' },
        { key: 'Wi-Fi', value: 'iSolarCloud Wi-Fi/Ethernet' },
      ],
    },
    {
      company: companyId,
      category: getCatId('Inverters'),
      type: 'general',
      name: 'Havells Enviro GT 3.3kW Single Phase Inverter',
      brand: 'Havells',
      model: 'Enviro GT 3300',
      sku: 'INV-HV-3K',
      price: 36000,
      warrantyYears: 7,
      unit: 'Piece',
      description: '3.3 kW single MPPT residential solar inverter, lightweight IP65 rated.',
      specs: [
        { key: 'Capacity (kW)', value: '3.3' },
        { key: 'MPPT count', value: '1' },
        { key: 'Phase', value: 'Single Phase' },
        { key: 'Max Efficiency (%)', value: '97.6' },
      ],
    },

    // 4. Wire & Cabling
    {
      company: companyId,
      category: getCatId('Wire & Cabling'),
      type: 'general',
      name: 'Polycab Solar DC Cable 4 sq.mm (Red & Black Bundle)',
      brand: 'Polycab',
      model: 'Solar DC 4sq.mm',
      sku: 'CAB-DC-4MM',
      price: 4500,
      warrantyYears: 25,
      unit: 'Bundle',
      description: '100m bundle of UV and ozone resistant tinned copper solar DC cable.',
      specs: [
        { key: 'Size (sq.mm)', value: '4 sq.mm' },
        { key: 'Conductor', value: 'Class 5 Tinned Copper' },
        { key: 'Insulation', value: 'Cross-linked Polyolefin (XLPO)' },
        { key: 'Voltage rating', value: '1500V DC' },
      ],
    },
    {
      company: companyId,
      category: getCatId('Wire & Cabling'),
      type: 'general',
      name: 'Havells 4-Core 10 sq.mm Armoured AC Cable (50m Coil)',
      brand: 'Havells',
      model: '4C 10sq.mm Armoured',
      sku: 'CAB-AC-10MM',
      price: 8500,
      warrantyYears: 10,
      unit: 'Bundle',
      description: 'Heavy duty XLPE insulated aluminium armoured cable for inverter to LT panel connection.',
      specs: [
        { key: 'Size (sq.mm)', value: '10 sq.mm' },
        { key: 'Conductor', value: 'Aluminium Stranded' },
        { key: 'Insulation', value: 'XLPE' },
        { key: 'Voltage rating', value: '1100V AC' },
      ],
    },

    // 5. Chemical Earthing Kit
    {
      company: companyId,
      category: getCatId('Chemical Earthing Kit'),
      type: 'general',
      name: 'Ashlok Pure-Copper Bonded Earthing Electrode Set (3m)',
      brand: 'Ashlok',
      model: 'Safe-Earth 50mm x 3m',
      sku: 'EARTH-ASH-3M',
      price: 4200,
      warrantyYears: 10,
      unit: 'Set',
      description: 'Maintenance-free 50mm copper bonded pipe-in-strip electrode with 25kg carbon backfill compound.',
      specs: [
        { key: 'Electrode type', value: 'Copper Bonded Steel' },
        { key: 'Length (m)', value: '3.0' },
        { key: 'Diameter (mm)', value: '50' },
        { key: 'Backfill compound', value: '25 kg BFC Compound Included' },
      ],
    },

    // 6. ACDB Box
    {
      company: companyId,
      category: getCatId('ACDB Box'),
      type: 'general',
      name: 'Schneider Acti9 3-Phase 32A ACDB with Type-2 SPD',
      brand: 'Schneider Electric',
      model: 'Acti9 32A-4P',
      sku: 'ACDB-SCH-32A',
      price: 6800,
      warrantyYears: 5,
      unit: 'Piece',
      description: 'Weatherproof IP65 polycarbonate ACDB with 4-pole 32A MCB, Class-II SPD, and isolation.',
      specs: [
        { key: 'Rating (A)', value: '32A' },
        { key: 'Phases', value: 'Three Phase + Neutral' },
        { key: 'SPD Class', value: 'Type 2 AC Surge Protector' },
        { key: 'IP Rating', value: 'IP65' },
      ],
    },
    {
      company: companyId,
      category: getCatId('ACDB Box'),
      type: 'general',
      name: 'L&T Single Phase 25A AC Distribution Box',
      brand: 'L&T Electrical',
      model: 'Exora 25A-2P',
      sku: 'ACDB-LT-25A',
      price: 3400,
      warrantyYears: 5,
      unit: 'Piece',
      description: 'Single phase AC distribution box with 2-pole 25A MCB and 20kA surge protection.',
      specs: [
        { key: 'Rating (A)', value: '25A' },
        { key: 'Phases', value: 'Single Phase (2P)' },
        { key: 'SPD Class', value: 'Type 2' },
        { key: 'IP Rating', value: 'IP65' },
      ],
    },

    // 7. DCDB Box
    {
      company: companyId,
      category: getCatId('DCDB Box'),
      type: 'general',
      name: 'Hensel PV 2-In 2-Out 1000V DC Distribution Box',
      brand: 'Hensel',
      model: 'Enystar PV 2-In 2-Out',
      sku: 'DCDB-HN-2IN',
      price: 5600,
      warrantyYears: 5,
      unit: 'Piece',
      description: '2 String Input / 2 Output DCDB with 1000V DC 15A fuses and 1000V Type 2 DC SPD.',
      specs: [
        { key: 'Inputs / Outputs', value: '2 Inputs / 2 Outputs' },
        { key: 'Fuse rating (A)', value: '15A 1000V DC' },
        { key: 'SPD rating (kV)', value: '1000V DC Type 2' },
        { key: 'Enclosure', value: 'IP65 Polycarbonate UV Resistant' },
      ],
    },

    // 8. Mounting Structure / Hardware
    {
      company: companyId,
      category: getCatId('Mounting Structure / Hardware'),
      type: 'general',
      name: 'Complete Aluminum Module Mounting Rail & Clamp Kit (per kW)',
      brand: 'Pennar Solar',
      model: 'Rail-AL-4100',
      sku: 'MMS-AL-1KW',
      price: 3200,
      warrantyYears: 20,
      unit: 'Set',
      description: 'Anodized 6063-T6 aluminum mounting rails with mid clamps, end clamps, and SS304 fasteners.',
      specs: [
        { key: 'Material', value: 'AL 6063 T6 Anodized' },
        { key: 'Hardware grade', value: 'SS304 Stainless Steel' },
        { key: 'Wind speed rating (km/h)', value: '170 km/h' },
      ],
    },

    // 9. Batteries & Energy Storage
    {
      company: companyId,
      category: getCatId('Batteries & Energy Storage'),
      type: 'general',
      name: 'Luminous Solarverter 5.12kWh LiFePO4 Lithium Battery',
      brand: 'Luminous',
      model: 'LFP 51.2V 100Ah',
      sku: 'BAT-LUM-5KWH',
      price: 135000,
      warrantyYears: 10,
      unit: 'Piece',
      description: '51.2V 100Ah LiFePO4 high-cycle wall mount battery with smart BMS and CAN/RS485 communication.',
      specs: [
        { key: 'Capacity (kWh)', value: '5.12 kWh' },
        { key: 'Chemistry', value: 'Lithium Iron Phosphate (LiFePO4)' },
        { key: 'Voltage (V)', value: '51.2V' },
        { key: 'Cycle life', value: '6000 cycles @ 80% DoD' },
      ],
    },
  ];

  await insertStarterProducts(companyId, productsToInsert, new Map(categories.map((c) => [String(c._id), c])));
  await seedParentCategories(companyId); // "Structures" and "Electricals", with the categories above filed under them

  // Sample turnkey packages (add catalog products to line items from Dashboard → Packages).
  await Package.insertMany([
    {
      company: companyId,
      name: '3kW Residential Smart Solar Package',
      kw: 3,
      price: 185000,
      description: 'Complete 3kW turnkey residential on-grid solar package with Tata panels and Havells inverter.',
      items: [],
    },
    {
      company: companyId,
      name: '5kW Premium Turnkey Solar Package',
      kw: 5,
      price: 265000,
      description: 'Popular 5kW rooftop system with Tier-1 modules and a grid-tied inverter.',
      items: [],
    },
    {
      company: companyId,
      name: '10kW Commercial Three-Phase Package',
      kw: 10,
      price: 495000,
      description: '10kW three-phase turnkey installation for schools, hospitals, and commercial rooftops.',
      items: [],
    },
  ]);
}

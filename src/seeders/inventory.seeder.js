// A large, varied inventory for one company, for manual testing (see data/inventory.js for what each product covers):
// suppliers, categories that are missing, new products with every field filled, several receipts per product through
// stock.service.js (so batches and serial units are exactly as real receipts would make them), and two extra receipts
// for every product the company already had. Safe to re-run: a supplier that exists (by name), a product that exists
// (by SKU, or name when there is no SKU) and a batch that exists (by batch number) are left alone.
import { Batch, Category, Company, EwayBill, Product, SerialUnit, Supplier } from '../models/index.js';
import { attributeKey, cleanAttributeDefs, validateAttributes } from '../services/attribute.service.js';
import { receiveStock } from '../services/stock.service.js';
import { EXTRA_BATCHES_FOR_EXISTING, INVENTORY_CATEGORIES, INVENTORY_PRODUCTS, INVENTORY_SUPPLIERS, SECOND_SOURCE, SHOWCASE_SUPPLIER_FALLBACK } from './data/inventory.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const round = (v) => Math.round(v);

/** Retail price → the batch's four prices (wholesale and base below retail, purchase below those), with overrides. */
const pricesFrom = (retail, overrides = {}) => {
  const out = { retailPrice: retail, wholesalePrice: round(retail * 0.92), basePrice: round(retail * 0.86), purchasePrice: round(retail * 0.78), ...overrides };
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k]; // a blank optional price
  return out;
};

const defaultSerial = (sku, tag) => (n) => `${sku || 'SN'}-${tag}-${String(n).padStart(4, '0')}`;

export async function seedInventory(companyId, { dryRun = false, log = console.log } = {}) {
  const company = await Company.findById(companyId);
  if (!company) throw new Error(`No company ${companyId}`);
  const stats = { suppliers: 0, categories: 0, products: 0, batches: 0, units: 0, skipped: { suppliers: 0, products: 0, batches: 0 } };

  // product units the company doesn't list yet are added (Panel, Kg, Lot…)
  const units = [...(company.productUnits || [])];
  const unitFor = (raw) => {
    const wanted = String(raw || 'Piece');
    const found = units.find((u) => u.toLowerCase() === wanted.toLowerCase());
    if (found) return found;
    units.push(wanted);
    return wanted;
  };

  /* suppliers, by name */
  const suppliers = new Map((await Supplier.find({ company: company._id }).lean()).map((s) => [s.name.toLowerCase(), s]));
  const categoriesByName = new Map((await Category.find({ company: company._id }).lean()).map((c) => [c.name.toLowerCase(), c]));
  const ensureCategory = async (def) => {
    const have = categoriesByName.get(def.name.toLowerCase());
    if (have) return have;
    log(`  + category ${def.name}`);
    stats.categories += 1;
    if (dryRun) {
      const fake = { _id: null, name: def.name, type: def.type || 'general', attributes: cleanAttributeDefs(def.attributes) };
      categoriesByName.set(def.name.toLowerCase(), fake);
      return fake;
    }
    const created = await Category.create({ ...def, attributes: cleanAttributeDefs(def.attributes), type: def.type || 'general', company: company._id, position: categoriesByName.size + 1 });
    const lean = created.toObject();
    categoriesByName.set(def.name.toLowerCase(), lean);
    return lean;
  };
  const ensureSupplier = async (def) => {
    const have = suppliers.get(def.name.toLowerCase());
    if (have) {
      stats.skipped.suppliers += 1;
      return have;
    }
    const categoryIds = [];
    for (const name of def.categories || []) {
      const cat = categoriesByName.get(name.toLowerCase()) || await ensureCategory(INVENTORY_CATEGORIES.find((c) => c.name === name));
      if (cat?._id) categoryIds.push(cat._id);
    }
    log(`  + supplier ${def.name}${def.gstNumber ? '' : ' (no GSTIN)'}`);
    stats.suppliers += 1;
    const row = dryRun ? { _id: null, ...def } : (await Supplier.create({ ...def, categories: categoryIds, company: company._id })).toObject();
    suppliers.set(def.name.toLowerCase(), row);
    return row;
  };
  for (const def of INVENTORY_CATEGORIES) await ensureCategory(def);
  for (const def of SHOWCASE_SUPPLIER_FALLBACK) await ensureSupplier(def);
  for (const def of INVENTORY_SUPPLIERS) await ensureSupplier(def);
  const supplierId = (name) => suppliers.get(name.toLowerCase())?._id;

  /* one receipt through the stock service, then the optional consumption */
  const receive = async (product, r, { batchNo, serialFormat, serialTag }) => {
    const qty = r.qty;
    const body = {
      supplier: supplierId(r.supplier),
      batchNo,
      receivedDate: daysAgo(r.days),
      ...(r.mfgDate ? { mfgDate: daysAgo(r.mfgDate) } : {}),
      ...(r.mfgYear ? { mfgYear: r.mfgYear } : {}),
      ...pricesFrom(r.retail, r.prices),
      note: r.note || '',
      ...(product.isSerialized
        ? { serials: Array.from({ length: qty }, (_, k) => (serialFormat || defaultSerial(product.sku, serialTag))(k + 1)) }
        : { qtyReceived: qty }),
    };
    stats.batches += 1;
    if (product.isSerialized) stats.units += qty;
    if (dryRun) return;
    const created = await receiveStock(company, product._id, body);
    if (!product.isSerialized && r.consumed > 0) {
      await Batch.updateOne({ _id: created._id }, { $set: { qtyRemaining: Math.max(0, qty - Math.min(qty, r.consumed)) } });
    }
  };

  /* the seed's own products */
  const existingBySku = new Map((await Product.find({ company: company._id, sku: { $ne: '' } }).select('sku').lean()).map((p) => [p.sku, p]));
  const seedProductIds = []; // the seed's own products (new or from an earlier run): they don't get the "second source" receipts below
  for (const def of INVENTORY_PRODUCTS) {
    const { category: categoryName, scenario, batches, attributes, serialFormat, ...fields } = def;
    const exists = fields.sku ? existingBySku.get(fields.sku) : await Product.findOne({ company: company._id, name: fields.name }).select('_id').lean();
    if (exists) {
      stats.skipped.products += 1;
      seedProductIds.push(exists._id);
      continue;
    }
    const category = categoriesByName.get(categoryName.toLowerCase());
    const values = Object.fromEntries(Object.entries(attributes).map(([label, v]) => [attributeKey(label), v]));
    log(`  + product ${fields.name} — ${scenario}`);
    stats.products += 1;
    let product = { _id: null, sku: fields.sku, isSerialized: Boolean(fields.isSerialized) };
    if (!dryRun) {
      product = await Product.create({
        ...fields,
        unit: unitFor(fields.unit),
        company: company._id,
        category: category._id,
        type: category.type || 'general',
        isSerialized: Boolean(fields.isSerialized),
        attributes: validateAttributes(category.attributes, values),
      });
      seedProductIds.push(product._id);
    }
    for (const [n, r] of batches.entries()) {
      await receive(product, r, { batchNo: `${fields.sku || fields.name.slice(0, 6).toUpperCase()}-${n + 1}`, serialFormat, serialTag: String(n + 1) });
    }
  }

  /* two more receipts for every product the company already had */
  const others = await Product.find({ company: company._id, _id: { $nin: seedProductIds } }).populate('category', 'name').lean();
  for (const p of others) {
    const have = await Batch.find({ company: company._id, product: p._id }).select('batchNo supplier qtyReceived retailPrice').lean();
    if (!have.length) continue; // only products that were received before get a second source
    const baseNo = p.sku || String(p._id).slice(-6).toUpperCase();
    const totalQty = have.reduce((a, b) => a + (Number(b.qtyReceived) || 0), 0);
    const retail = Math.max(...have.map((b) => Number(b.retailPrice) || 0));
    const sources = (SECOND_SOURCE[p.category?.name] || [INVENTORY_SUPPLIERS[4].name, INVENTORY_SUPPLIERS[2].name]).filter((name) => !have.some((b) => String(b.supplier) === String(supplierId(name))));
    let added = 0;
    for (const [i, x] of EXTRA_BATCHES_FOR_EXISTING.entries()) {
      const batchNo = `${baseNo}-${x.suffix}`;
      if (have.some((b) => b.batchNo === batchNo)) {
        stats.skipped.batches += 1;
        continue;
      }
      const qty = Math.max(1, Math.ceil(totalQty * x.share));
      const supplier = sources[i % sources.length] || INVENTORY_SUPPLIERS[4].name;
      await receive(p, { supplier, qty, retail: round(retail * x.priceFactor), days: x.days, mfgDate: x.mfgDate, mfgYear: x.mfgYear, note: x.note }, { batchNo, serialTag: x.suffix });
      added += 1;
    }
    if (added) log(`  + ${added} more receipt${added === 1 ? '' : 's'} for ${p.name}`);
  }

  if (!dryRun && units.length !== (company.productUnits || []).length) await Company.updateOne({ _id: company._id }, { productUnits: units });
  return stats;
}

/**
 * Undo the seed: its products (with their batches and serial units), the extra -S1/-S2 batches on other products, and
 * its suppliers. Refused when any of that stock has left (a sold unit, an e-way bill line, a consumed extra batch),
 * because documents would then point at missing rows.
 */
export async function resetInventory(companyId, { log = console.log } = {}) {
  const company = await Company.findById(companyId);
  if (!company) throw new Error(`No company ${companyId}`);
  const skus = INVENTORY_PRODUCTS.map((p) => p.sku).filter(Boolean);
  const names = INVENTORY_PRODUCTS.filter((p) => !p.sku).map((p) => p.name);
  const products = await Product.find({ company: company._id, $or: [{ sku: { $in: skus } }, { name: { $in: names } }] }).select('_id name').lean();
  const productIds = products.map((p) => p._id);
  const extra = await Batch.find({ company: company._id, product: { $nin: productIds }, batchNo: { $regex: /-S[12]$/ } }).lean();
  const batchIds = [...(await Batch.find({ company: company._id, product: { $in: productIds } }).select('_id').lean()).map((b) => b._id), ...extra.map((b) => b._id)];

  const sold = await SerialUnit.countDocuments({ company: company._id, batch: { $in: batchIds }, status: { $ne: 'inStock' } });
  const onEway = await EwayBill.countDocuments({ company: company._id, 'lines.batch': { $in: batchIds.map(String) } });
  const consumedExtra = extra.filter((b) => b.qtyRemaining < b.qtyReceived).length; // per-batch stock taken from an extra batch
  if (sold || onEway || consumedExtra) throw new Error(`Refusing to reset: ${sold} seeded unit(s) sold, ${onEway} e-way bill(s) use seeded batches, ${consumedExtra} extra batch(es) consumed. Documents would point at missing stock.`);

  const units = await SerialUnit.deleteMany({ company: company._id, batch: { $in: batchIds } });
  const batches = await Batch.deleteMany({ _id: { $in: batchIds } });
  const removedProducts = await Product.deleteMany({ _id: { $in: productIds } });
  const supplierNames = INVENTORY_SUPPLIERS.map((s) => s.name);
  const stillUsed = await Batch.distinct('supplier', { company: company._id });
  const removable = await Supplier.find({ company: company._id, name: { $in: supplierNames }, _id: { $nin: stillUsed } }).select('_id name').lean();
  await Supplier.deleteMany({ _id: { $in: removable.map((s) => s._id) } });
  const cat = await Category.findOne({ company: company._id, name: 'Accessories & Consumables' }).select('_id').lean();
  let removedCategory = 0;
  if (cat && !(await Product.exists({ category: cat._id }))) {
    await Category.deleteOne({ _id: cat._id });
    await Supplier.updateMany({ company: company._id }, { $pull: { categories: cat._id } });
    removedCategory = 1;
  }
  log(`  − ${removedProducts.deletedCount} products, ${batches.deletedCount} batches, ${units.deletedCount} serial units, ${removable.length} suppliers, ${removedCategory} category`);
  return { products: removedProducts.deletedCount, batches: batches.deletedCount, units: units.deletedCount, suppliers: removable.length, category: removedCategory };
}

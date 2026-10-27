// The showcase catalog for one company: categories with typed attributes, their products, suppliers, and stock
// received in two batches per product (an older, cheaper one and a newer one, so FIFO has something to do). Products
// of serialized categories get one serial unit per item. Stock goes in through stock.service.js like real receipts.
import { Category, Company, Product, Supplier } from '../models/index.js';
import { attributeKey, cleanAttributeDefs, validateAttributes } from '../services/attribute.service.js';
import { receiveStock } from '../services/stock.service.js';
import { SHOWCASE_CATEGORIES, SHOWCASE_SUPPLIERS } from './data/showcase.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const round = (v) => Math.round(v);

/** Retail price → the batch's four prices (wholesale and base below retail, purchase below those). */
const pricesFrom = (retail) => ({ retailPrice: retail, wholesalePrice: round(retail * 0.92), basePrice: round(retail * 0.86), purchasePrice: round(retail * 0.78) });

/**
 * Adds the catalog and its stock to `companyId`. Units the company doesn't have yet (e.g. Panel) are added to its list.
 * Returns the products by SKU (for packages and installations).
 */
export async function seedShowcaseCatalog(companyId) {
  const company = await Company.findById(companyId);
  const units = [...(company.productUnits || [])];
  const unitFor = (raw) => {
    const wanted = String(raw || 'Piece');
    const found = units.find((u) => u.toLowerCase() === wanted.toLowerCase());
    if (found) return found;
    units.push(wanted);
    return units.at(-1);
  };

  const suppliers = new Map();
  for (const { categories, ...fields } of SHOWCASE_SUPPLIERS) {
    const supplier = await Supplier.create({ ...fields, company: company._id });
    for (const name of categories) suppliers.set(name, supplier);
  }

  const bySku = new Map();
  for (const [position, c] of SHOWCASE_CATEGORIES.entries()) {
    const { products: items, serialized = false, attributes, ...fields } = c;
    const category = await Category.create({ ...fields, attributes: cleanAttributeDefs(attributes), type: fields.type || 'general', company: company._id, position: position + 1 });
    for (const [i, raw] of items.entries()) {
      const { price, quantity, warrantyYears = 0, manufactureYear = null, specs = [], unit, ...productFields } = raw;
      const values = Object.fromEntries(specs.filter((s) => s.value && s.value !== '—').map((s) => [attributeKey(s.key), s.value]));
      const product = await Product.create({
        ...productFields,
        unit: unitFor(unit),
        company: company._id,
        category: category._id,
        type: category.type,
        isSerialized: serialized,
        warrantyMonths: warrantyYears * 12,
        reorderLevel: Math.ceil(quantity * 0.15),
        attributes: validateAttributes(category.attributes, values),
      });
      if (product.sku) bySku.set(product.sku, product);

      // two receipts: 40% two months ago at 3% less, the rest three weeks ago at today's price
      const older = Math.max(1, Math.round(quantity * 0.4));
      const receipts = [
        { qty: older, retail: round(price * 0.97), days: 60 - i, batchNo: `${product.sku || 'B'}-A` },
        { qty: quantity - older, retail: price, days: 21 - i, batchNo: `${product.sku || 'B'}-B` },
      ].filter((r) => r.qty > 0);
      for (const [n, r] of receipts.entries()) {
        await receiveStock(company, product._id, {
          supplier: suppliers.get(category.name)?._id,
          batchNo: r.batchNo,
          mfgYear: manufactureYear ?? undefined,
          receivedDate: daysAgo(r.days),
          ...pricesFrom(r.retail),
          qtyReceived: serialized ? undefined : r.qty,
          serials: serialized ? Array.from({ length: r.qty }, (_, k) => `${product.sku}-${n + 1}${String(k + 1).padStart(4, '0')}`) : undefined,
        });
      }
    }
  }
  if (units.length !== (company.productUnits || []).length) await Company.updateOne({ _id: company._id }, { productUnits: units });
  return bySku;
}

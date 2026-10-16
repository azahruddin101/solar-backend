// A ready catalog for one company: the showcase categories (each with several products and its spec keys),
// the packages built from those products, and every category filed under its parent category.
import { Category, Company, Package, Product } from '../models/index.js';
import { seedParentCategories } from '../migrations/parentCategory.migration.js';
import { SHOWCASE_CATEGORIES, SHOWCASE_PACKAGES } from './data/showcase.js';

/** Adds the catalog to a company that has no categories yet; a company that already has some is left untouched. */
export async function seedCatalog(companyId) {
  const company = await Company.findById(companyId);
  if (!company) throw new Error(`No company ${companyId}`);
  if (await Category.exists({ company: company._id })) return null;

  // products use the company's own unit names; a unit it doesn't have yet (e.g. Panel) is added to its list
  const units = [...(company.productUnits || [])];
  const unitFor = (raw) => {
    const wanted = String(raw || 'Piece');
    const found = units.find((u) => u.toLowerCase() === wanted.toLowerCase());
    if (found) return found;
    units.push(wanted);
    return units.at(-1);
  };

  const bySku = new Map();
  let products = 0;
  for (const [position, c] of SHOWCASE_CATEGORIES.entries()) {
    const { products: items, ...fields } = c;
    const category = await Category.create({ ...fields, type: fields.type || 'general', company: company._id, position: position + 1 });
    for (const p of items) {
      const product = await Product.create({ ...p, unit: unitFor(p.unit), company: company._id, category: category._id, type: category.type });
      if (p.sku) bySku.set(p.sku, product);
      products++;
    }
  }
  for (const pkg of SHOWCASE_PACKAGES) {
    const { lines, ...fields } = pkg;
    const items = lines.map(([sku, qty]) => ({ productId: bySku.get(sku)._id, qty, unit: bySku.get(sku).unit }));
    await Package.create({ ...fields, items, company: company._id });
  }
  if (units.length !== (company.productUnits || []).length) await Company.updateOne({ _id: company._id }, { productUnits: units });
  await seedParentCategories(company._id);
  return { categories: SHOWCASE_CATEGORIES.length, products, packages: SHOWCASE_PACKAGES.length };
}

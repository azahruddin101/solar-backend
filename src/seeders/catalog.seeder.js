// A ready catalog for one company: the showcase categories (each with several products, its attributes and stock),
// the packages built from those products, and every category filed under its parent category.
import { Category, Company, Package } from '../models/index.js';
import { seedParentCategories } from '../migrations/parentCategory.migration.js';
import { SHOWCASE_CATEGORIES, SHOWCASE_PACKAGES } from './data/showcase.js';
import { seedShowcaseCatalog } from './showcaseCatalog.js';

/** Adds the catalog to a company that has no categories yet; a company that already has some is left untouched. */
export async function seedCatalog(companyId) {
  const company = await Company.findById(companyId);
  if (!company) throw new Error(`No company ${companyId}`);
  if (await Category.exists({ company: company._id })) return null;

  const bySku = await seedShowcaseCatalog(company._id);
  for (const pkg of SHOWCASE_PACKAGES) {
    const { lines, ...fields } = pkg;
    const items = lines.map(([sku, qty]) => ({ productId: bySku.get(sku)._id, qty, unit: bySku.get(sku).unit }));
    await Package.create({ ...fields, items, company: company._id });
  }
  await seedParentCategories(company._id);
  return { categories: SHOWCASE_CATEGORIES.length, products: bySku.size, packages: SHOWCASE_PACKAGES.length };
}

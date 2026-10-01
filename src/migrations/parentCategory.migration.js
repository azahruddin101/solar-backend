import { DEFAULT_PARENT_CATEGORIES } from '../constants/index.js';
import { Category, Company, ParentCategory } from '../models/index.js';

/** The default parent category a category belongs under, judged by its designer use and its name. */
export function defaultParentOf(category) {
  if (category.type === 'panels' || category.type === 'poles') return DEFAULT_PARENT_CATEGORIES[0].name;
  return DEFAULT_PARENT_CATEGORIES.find((p) => p.match.test(category.name || ''))?.name || null;
}

/** Creates the default parent categories for one company and files its still-unfiled categories under them. */
export async function seedParentCategories(companyId) {
  const parents = new Map();
  for (const [i, p] of DEFAULT_PARENT_CATEGORIES.entries()) {
    const existing = await ParentCategory.findOne({ company: companyId, name: p.name }).collation({ locale: 'en', strength: 2 });
    parents.set(p.name, existing || (await ParentCategory.create({ company: companyId, name: p.name, description: p.description, position: i + 1 })));
  }
  let filed = 0;
  for (const c of await Category.find({ company: companyId, parent: null })) {
    const parent = parents.get(defaultParentOf(c));
    if (!parent) continue; // no obvious group: it stays as it is, under "Other items"
    await Category.updateOne({ _id: c._id }, { parent: parent._id });
    filed++;
  }
  await Company.updateOne({ _id: companyId }, { parentCategoriesSeeded: true });
  return filed;
}

/**
 * Parent categories came after the catalog: every company that has none of its own yet gets "Structures"
 * and "Electricals", with its existing categories filed under them. Nothing is deleted or renamed; categories
 * and products stay exactly as they are. Runs once per company.
 */
export async function migrateParentCategories() {
  let companies = 0;
  let filed = 0;
  for (const c of await Company.find({ parentCategoriesSeeded: { $ne: true } }).select('_id')) {
    filed += await seedParentCategories(c._id);
    companies++;
  }
  if (companies) console.log(`Parent categories: created for ${companies} companies, ${filed} categories grouped`);
}

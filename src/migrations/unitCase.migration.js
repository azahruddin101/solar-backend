import { Category, Client, Company, Package, Product } from '../models/index.js';
import { capWords } from '../utils/text.js';

// "nos" → "Nos": upper-case the first letter of every product unit already stored. Only touches values that
// start with a lower-case letter, so it does nothing once done.
const cap = (expr) => ({ $concat: [{ $toUpper: { $substrCP: [expr, 0, 1] } }, { $substrCP: [expr, 1, { $strLenCP: expr }] }] });
const lowerStart = { $regex: '^[a-z]' };

export async function capitalizeProductUnits() {
  const products = await Product.collection.updateMany({ unit: lowerStart }, [{ $set: { unit: cap('$unit') } }]);
  const packages = await Package.collection.updateMany({ 'items.unit': lowerStart }, [{ $set: { items: { $map: { input: '$items', as: 'it', in: { $mergeObjects: ['$$it', { unit: { $cond: [{ $regexMatch: { input: { $ifNull: ['$$it.unit', ''] }, regex: '^[a-z]' } }, cap('$$it.unit'), '$$it.unit'] } }] } } } } }]);
  const companies = await Company.collection.updateMany({ productUnits: lowerStart }, [{ $set: { productUnits: { $map: { input: '$productUnits', as: 'u', in: { $cond: [{ $regexMatch: { input: '$$u', regex: '^[a-z]' } }, cap('$$u'), '$$u'] } } } } }]);
  const n = products.modifiedCount + packages.modifiedCount + companies.modifiedCount;
  if (n) console.log(`Unit names capitalised: ${products.modifiedCount} products, ${packages.modifiedCount} packages, ${companies.modifiedCount} companies`);
}

/** Same for product names and brands, package names and category names ("waaree solar panel" → "Waaree solar panel"). */
export async function capitalizeProductNames() {
  let changed = 0;
  for (const [Model, field] of [[Product, 'name'], [Product, 'brand'], [Package, 'name'], [Category, 'name']]) {
    const r = await Model.collection.updateMany({ [field]: lowerStart }, [{ $set: { [field]: cap(`$${field}`) } }]);
    changed += r.modifiedCount;
  }
  if (changed) console.log(`Names capitalised: ${changed} fields (products, brands, packages, categories)`);
}

/** Client names: first letter of every word. */
export async function capitalizeClientNames() {
  let changed = 0;
  for await (const c of Client.collection.find({ name: { $regex: '(^|\\s)[a-z]' } }, { projection: { name: 1 } })) {
    await Client.collection.updateOne({ _id: c._id }, { $set: { name: capWords(c.name) } });
    changed++;
  }
  if (changed) console.log(`Client names capitalised: ${changed}`);
}

// One-time move of the old fixed `panels` / `pillars` collections into categories + products.
// Runs at start-up and does nothing once those collections are gone. Ids are kept, so saved designs
// still point at the same panel and pole.
import mongoose from 'mongoose';
import { Category, Product } from '../models/index.js';

const NAMES = { panels: 'Solar panels', poles: 'Poles / pillars' };

async function categoryFor(cache, company, type) {
  const key = `${company}|${type}`;
  if (!cache.has(key)) {
    const existing = await Category.findOne({ company, type }).sort({ createdAt: 1 });
    cache.set(key, existing || (await Category.create({ company, type, name: NAMES[type] })));
  }
  return cache.get(key);
}

async function move(db, collection, type, toProduct) {
  if (!(await db.listCollections({ name: collection }).hasNext())) return 0;
  const cache = new Map();
  let moved = 0;
  for await (const old of db.collection(collection).find()) {
    if (!(await Product.exists({ _id: old._id }))) {
      const category = await categoryFor(cache, old.company, type);
      await Product.create({ _id: old._id, company: old.company, category: category._id, type, description: old.description, specs: old.specs, createdAt: old.createdAt, updatedAt: old.updatedAt, ...toProduct(old) });
      moved++;
    }
  }
  await db.collection(collection).drop();
  return moved;
}

export async function migrateCatalog() {
  const db = mongoose.connection.db;
  const panels = await move(db, 'panels', 'panels', (p) => ({ name: `${p.brand} ${p.model || ''}`.trim(), brand: p.brand, model: p.model, watts: p.watts, manufactureYear: p.manufactureYear, warrantyYears: p.warrantyYears, length: p.length, width: p.width, price: p.price, unit: 'Panel' }));
  const poles = await move(db, 'pillars', 'poles', (p) => ({ name: p.name, shape: p.shape, price: p.pricePerFt, unit: 'Foot' }));
  // a category without a type (there was a short time when only products had one) takes it from its products
  for (const category of await db.collection('categories').find({ type: { $exists: false } }).toArray()) {
    const [top] = await db.collection('products').aggregate([{ $match: { category: category._id } }, { $group: { _id: '$type', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
    const type = top?._id || 'general';
    await db.collection('categories').updateOne({ _id: category._id }, { $set: { type } });
    await db.collection('products').updateMany({ category: category._id }, { $set: { type } });
  }
  if (panels || poles) console.log(`Catalog migrated: ${panels} panels and ${poles} poles are now products in categories.`);
}

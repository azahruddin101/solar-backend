// One-time: move prices, stock and manufacture years off products into batches (the new stock model).
//   node --env-file-if-exists=.env src/scripts/migrate-product-stock.js            dry run: prints what it would do
//   node --env-file-if-exists=.env src/scripts/migrate-product-stock.js --apply    writes
//
// For every company:
//   - an "Opening stock" supplier, which the migrated batches are filed under;
//   - categories: `specKeys` → text attribute definitions (`attributes`);
//   - products: `specs` → `attributes`, `warrantyYears` → `warrantyMonths`, `isSerialized` set for panel, inverter and
//     battery categories;
//   - one batch per product: qty = the old `quantity` (0 still gets a batch, so the price is kept), mfgYear = the old
//     `manufactureYear`, base = wholesale = retail = the old `price` (or `mrp` when there is no price), purchase = 0;
//   - serialized products with stock get placeholder serial units LEGACY-<sku or id>-0001… to be replaced by the
//     real serial numbers.
// Products that already have a batch are skipped, so it is safe to re-run. The old fields (price, quantity,
// manufactureYear, mrp, warrantyYears, specs, specKeys) are NOT removed; run with --drop-old-fields once the data is
// confirmed correct.
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { attributeKey, textAttributes } from '../services/attribute.service.js';

const apply = process.argv.includes('--apply');
const dropOld = process.argv.includes('--drop-old-fields');
const SERIALIZED = /panel|module|inverter|batter/i;
const OPENING = 'Opening stock';
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

await mongoose.connect(env.mongoUri);
const db = mongoose.connection.db;
const [companies, categories, products, batches, units, suppliers] = ['companies', 'categories', 'products', 'batches', 'serialunits', 'suppliers'].map((c) => db.collection(c));
const stats = { suppliers: 0, categories: 0, products: 0, batches: 0, units: 0, skipped: 0 };
const log = (...a) => console.log(apply ? '' : '[dry run]', ...a);

if (dropOld) {
  if (!apply) throw new Error('--drop-old-fields needs --apply');
  const p = await products.updateMany({}, { $unset: { price: '', quantity: '', manufactureYear: '', mrp: '', warrantyYears: '', specs: '' } });
  const c = await categories.updateMany({}, { $unset: { specKeys: '' } });
  console.log(`Old fields removed from ${p.modifiedCount} products and ${c.modifiedCount} categories.`);
  await mongoose.disconnect();
  process.exit(0);
}

for await (const company of companies.find({}, { projection: { name: 1 } })) {
  const now = new Date();
  let supplier = await suppliers.findOne({ company: company._id, name: OPENING });
  if (!supplier) {
    supplier = { _id: new mongoose.Types.ObjectId(), company: company._id, name: OPENING, phone: '', email: '', gstNumber: '', address: '', notes: 'Stock and prices from before batches were recorded', createdAt: now, updatedAt: now };
    if (apply) await suppliers.insertOne(supplier);
    stats.suppliers++;
  }

  const catById = new Map();
  for await (const cat of categories.find({ company: company._id })) {
    catById.set(String(cat._id), cat);
    if (Array.isArray(cat.attributes) && cat.attributes.length) continue;
    const attributes = textAttributes((cat.specKeys || []).filter(Boolean));
    cat.attributes = attributes;
    if (apply) await categories.updateOne({ _id: cat._id }, { $set: { attributes } });
    stats.categories++;
  }

  for await (const p of products.find({ company: company._id })) {
    if (await batches.findOne({ product: p._id }, { projection: { _id: 1 } })) {
      stats.skipped++;
      continue;
    }
    const category = catById.get(String(p.category));
    const isSerialized = p.isSerialized ?? SERIALIZED.test(category?.name || '');
    const attributes = { ...Object.fromEntries((p.specs || []).filter((s) => s?.key && s.value).map((s) => [attributeKey(s.key), s.value])), ...(p.attributes || {}) };
    const set = {
      attributes,
      isSerialized,
      warrantyMonths: p.warrantyMonths ?? Math.round((num(p.warrantyYears) || 0) * 12),
      reorderLevel: p.reorderLevel ?? 0,
    };
    const price = num(p.price) ?? num(p.mrp) ?? 0;
    const qty = Math.max(0, Math.floor(num(p.quantity) || 0));
    const batch = {
      _id: new mongoose.Types.ObjectId(),
      company: company._id,
      product: p._id,
      supplier: supplier._id,
      batchNo: 'OPENING',
      mfgDate: null,
      mfgYear: num(p.manufactureYear),
      receivedDate: p.createdAt || now,
      qtyReceived: qty,
      qtyRemaining: qty,
      purchasePrice: 0,
      basePrice: price,
      wholesalePrice: price,
      retailPrice: price,
      note: [OPENING, num(p.mrp) != null ? `MRP ${num(p.mrp)}` : ''].filter(Boolean).join(' · '),
      createdAt: now,
      updatedAt: now,
    };
    const serials = isSerialized ? Array.from({ length: qty }, (_, i) => `LEGACY-${p.sku || p._id}-${String(i + 1).padStart(4, '0')}`) : [];
    log(`${company.name} › ${p.name}: batch of ${qty} at ${price}${serials.length ? `, ${serials.length} placeholder serials` : ''}${isSerialized ? ' (serialized)' : ''}`);
    if (apply) {
      await products.updateOne({ _id: p._id }, { $set: set });
      await batches.insertOne(batch);
      if (serials.length) {
        await units.insertMany(serials.map((serialNo) => ({ company: company._id, product: p._id, batch: batch._id, serialNo, status: 'inStock', soldInvoice: null, installedProject: null, installDate: null, createdAt: now, updatedAt: now })));
      }
    }
    stats.products++;
    stats.batches++;
    stats.units += serials.length;
  }
}

console.log(`${apply ? 'Done' : 'Dry run'}: ${stats.suppliers} opening-stock suppliers, ${stats.categories} categories given attributes, ${stats.products} products → ${stats.batches} batches and ${stats.units} placeholder serial units; ${stats.skipped} products already had batches.`);
if (!apply) console.log('Nothing was written. Run again with --apply.');
await mongoose.disconnect();

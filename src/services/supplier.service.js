// The company's suppliers (who batches of stock were bought from).
import { Batch, Category, Product, Supplier } from '../models/index.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import { pick } from '../utils/pick.js';
import { objectId } from '../utils/validators.js';

const FIELDS = ['name', 'phone', 'email', 'gstNumber', 'address', 'notes', 'categories'];

async function getSupplier(company, id) {
  const supplier = await Supplier.findOne({ _id: objectId(id, 'Supplier'), company: company._id });
  if (!supplier) throw notFound('Supplier');
  return supplier;
}

async function applySupplier(company, supplier, body) {
  Object.assign(supplier, pick(body, FIELDS));
  const name = String(supplier.name ?? '').trim();
  if (!name) throw badRequest('Supplier name is required');
  if (body.categories !== undefined) {
    const ids = [...new Set(body.categories.map(String))];
    const found = await Category.countDocuments({ company: company._id, _id: { $in: ids } });
    if (found !== ids.length) throw badRequest('Choose the supplier’s categories from your product categories');
    supplier.categories = ids;
  }
  const twin = await Supplier.findOne({ company: company._id, _id: { $ne: supplier._id }, name }).collation({ locale: 'en', strength: 2 });
  if (twin) throw conflict('You already have a supplier with that name');
  return supplier.save();
}

export const supplierService = {
  list: (company) => Supplier.find({ company: company._id }).sort({ name: 1 }),
  get: getSupplier,
  /** Every batch received from the supplier, newest first, with its product and bill. */
  purchases: async (company, id) => {
    const supplier = await getSupplier(company, id);
    const batches = await Batch.find({ company: company._id, supplier: supplier._id }).sort({ receivedDate: -1, createdAt: -1 }).limit(500).lean();
    const products = await Product.find({ _id: { $in: batches.map((b) => b.product) } }).select('name unit brand model').lean();
    const byId = new Map(products.map((p) => [String(p._id), p]));
    return batches.map((b) => {
      const p = byId.get(String(b.product));
      return { id: String(b._id), productId: String(b.product), productName: p?.name || '', unit: p?.unit || '', batchNo: b.batchNo, receivedDate: b.receivedDate, qtyReceived: b.qtyReceived, qtyRemaining: b.qtyRemaining, purchasePrice: b.purchasePrice, billUrl: b.billUrl || '', billName: b.billName || '' };
    });
  },
  create: (company, body) => applySupplier(company, new Supplier({ company: company._id }), body),
  update: async (company, id, body) => applySupplier(company, await getSupplier(company, id), body),
  /** Only a supplier no batch was received from. */
  remove: async (company, id) => {
    const supplier = await getSupplier(company, id);
    if (await Batch.exists({ supplier: supplier._id })) throw conflict('Stock was received from this supplier, so it can’t be deleted');
    await supplier.deleteOne();
  },
};

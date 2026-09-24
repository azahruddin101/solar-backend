import { Category, Package, Product } from '../models/index.js';

/** Remove cross-company catalog links (legacy data or invalid package items). */
export async function enforceTenantCatalogIsolation() {
  const products = await Product.find({}, { _id: 1, company: 1, category: 1 }).lean();
  const categories = await Category.find({}, { _id: 1, company: 1 }).lean();
  const catCompany = new Map(categories.map((c) => [String(c._id), c.company]));

  let productsFixed = 0;
  for (const p of products) {
    const catCo = catCompany.get(String(p.category));
    if (catCo && String(catCo) !== String(p.company)) {
      await Product.deleteOne({ _id: p._id });
      productsFixed += 1;
    }
  }

  const productCompany = new Map(products.map((p) => [String(p._id), p.company]));
  const packages = await Package.find({}).lean();
  let packagesFixed = 0;
  for (const pkg of packages) {
    const companyId = String(pkg.company);
    const items = (pkg.items || []).filter((it) => {
      const owner = productCompany.get(String(it.productId));
      return owner && String(owner) === companyId;
    });
    if (items.length !== (pkg.items || []).length) {
      await Package.updateOne({ _id: pkg._id }, { $set: { items } });
      packagesFixed += 1;
    }
  }

  if (productsFixed || packagesFixed) {
    console.log(`Tenant catalog cleanup: removed ${productsFixed} mismatched products, fixed ${packagesFixed} packages`);
  }
}

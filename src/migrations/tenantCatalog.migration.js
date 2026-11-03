import { Category, Company, Package, Product } from '../models/index.js';

/**
 * Remove cross-company catalog links (legacy data or invalid package items). The catalog is owned by the organization
 * (shared by its branches, see sharedCatalog.migration.js), so "the same owner" means the same organization; a
 * document without one falls back to its branch.
 */
export async function enforceTenantCatalogIsolation() {
  const ownerOf = (d) => String(d.organization || d.company);
  const products = await Product.find({}, { _id: 1, company: 1, organization: 1, category: 1 }).lean();
  const categories = await Category.find({}, { _id: 1, company: 1, organization: 1 }).lean();
  const catOwner = new Map(categories.map((c) => [String(c._id), ownerOf(c)]));

  let productsFixed = 0;
  for (const p of products) {
    const owner = catOwner.get(String(p.category));
    if (owner && owner !== ownerOf(p)) {
      await Product.deleteOne({ _id: p._id });
      productsFixed += 1;
    }
  }

  const productOwner = new Map(products.map((p) => [String(p._id), ownerOf(p)]));
  const branchOrg = new Map((await Company.find({}).select('_id organization').setOptions({ rawBranch: true }).lean()).map((b) => [String(b._id), String(b.organization || b._id)]));
  const packages = await Package.find({}).lean();
  let packagesFixed = 0;
  for (const pkg of packages) {
    const owner = branchOrg.get(String(pkg.company)) || String(pkg.company);
    const items = (pkg.items || []).filter((it) => productOwner.get(String(it.productId)) === owner);
    if (items.length !== (pkg.items || []).length) {
      await Package.updateOne({ _id: pkg._id }, { $set: { items } });
      packagesFixed += 1;
    }
  }

  if (productsFixed || packagesFixed) {
    console.log(`Tenant catalog cleanup: removed ${productsFixed} mismatched products, fixed ${packagesFixed} packages`);
  }
}

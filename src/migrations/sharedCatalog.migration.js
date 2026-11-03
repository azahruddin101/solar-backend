// The product catalog moved from each branch to the organization (2026-11-03): parent categories, categories and
// products are shared by all of a company's branches, while stock (batches, serial units) and suppliers stay per branch.
//
// Runs at startup and is idempotent:
//   1. every catalog document gets `organization` from the branch it was created in;
//   2. in an organization whose branches each kept their own catalog, parent categories and categories with the same
//      name are merged into the oldest one (categories only when they are of the same designer type; a same-named
//      category of another type is renamed "<name> (<branch>)"). Products are NOT merged: their stock, invoices and
//      proposals point at them, so same-named products from different branches are kept and only reported.
import { Category, Company, ParentCategory, Product, Supplier } from '../models/index.js';

const nameKey = (s) => String(s ?? '').trim().toLowerCase();

async function backfillOrganization() {
  let set = 0;
  const branches = await Company.find({ organization: { $ne: null } }).select('_id organization').setOptions({ rawBranch: true }).lean();
  for (const M of [ParentCategory, Category, Product]) {
    const missing = await M.distinct('company', { $or: [{ organization: null }, { organization: { $exists: false } }] });
    if (!missing.length) continue;
    for (const b of branches.filter((x) => missing.some((id) => String(id) === String(x._id)))) {
      const r = await M.updateMany({ company: b._id, $or: [{ organization: null }, { organization: { $exists: false } }] }, { $set: { organization: b.organization } });
      set += r.modifiedCount;
    }
  }
  return set;
}

/** Groups by name, oldest first; returns [keeper, ...duplicates] for each name used more than once. */
function duplicateGroups(docs) {
  const groups = new Map();
  for (const d of docs) {
    const k = nameKey(d.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

async function mergeOrganization(orgId, branchNames) {
  const stats = { parents: 0, categories: 0, renamed: 0, sameNamedProducts: 0 };
  const byAge = { createdAt: 1, _id: 1 };

  for (const [keeper, ...dupes] of duplicateGroups(await ParentCategory.find({ organization: orgId }).sort(byAge).lean())) {
    const ids = dupes.map((d) => d._id);
    await Category.updateMany({ parent: { $in: ids } }, { $set: { parent: keeper._id } });
    await ParentCategory.deleteMany({ _id: { $in: ids } });
    stats.parents += ids.length;
  }

  for (const [keeper, ...dupes] of duplicateGroups(await Category.find({ organization: orgId }).sort(byAge).lean())) {
    const attributes = [...(keeper.attributes || [])];
    for (const d of dupes) {
      if (d.type !== keeper.type) {
        const branch = branchNames.get(String(d.company)) || 'branch';
        await Category.updateOne({ _id: d._id }, { $set: { name: `${String(d.name).trim()} (${branch})`.slice(0, 60) } });
        stats.renamed++;
        continue;
      }
      for (const a of d.attributes || []) if (!attributes.some((x) => x.key === a.key)) attributes.push(a);
      await Product.updateMany({ category: d._id }, { $set: { category: keeper._id } });
      await Supplier.updateMany({ categories: d._id }, { $addToSet: { categories: keeper._id } });
      await Supplier.updateMany({ categories: d._id }, { $pull: { categories: d._id } });
      await Category.deleteOne({ _id: d._id });
      stats.categories++;
    }
    await Category.updateOne({ _id: keeper._id }, { $set: { attributes, ...(keeper.parent ? {} : { parent: dupes.find((d) => d.parent && d.type === keeper.type)?.parent ?? null }) } });
  }

  const sameNamed = await Product.aggregate([
    { $match: { organization: orgId } },
    { $group: { _id: { c: '$category', n: { $toLower: '$name' }, b: { $toLower: { $ifNull: ['$brand', ''] } }, m: { $toLower: { $ifNull: ['$model', ''] } } }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  stats.sameNamedProducts = sameNamed.reduce((t, g) => t + g.n, 0);
  return stats;
}

export async function migrateSharedCatalog() {
  const set = await backfillOrganization();
  const branches = await Company.find({ organization: { $ne: null } }).select('_id name organization').setOptions({ rawBranch: true }).lean();
  const branchNames = new Map(branches.map((b) => [String(b._id), b.name]));
  const orgs = new Map();
  for (const b of branches) orgs.set(String(b.organization), (orgs.get(String(b.organization)) || 0) + 1);
  for (const [orgId, count] of orgs) {
    if (count < 2) continue;
    const id = branches.find((b) => String(b.organization) === orgId).organization;
    const s = await mergeOrganization(id, branchNames);
    if (s.parents || s.categories || s.renamed) console.log(`Shared catalog for organization ${orgId}: merged ${s.parents} parent categories and ${s.categories} categories, renamed ${s.renamed}`);
    if (s.sameNamedProducts) console.log(`Shared catalog for organization ${orgId}: ${s.sameNamedProducts} products share a name with another branch's product (kept; tidy them up from the catalog)`);
  }
  if (set) console.log(`Shared catalog: ${set} catalog documents now belong to their organization`);
}

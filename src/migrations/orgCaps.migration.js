// Company-wide caps (branches, clients, designs; clients and designs counted across every branch together) came back
// on 2026-11-03. Every company gets the caps of its plan once, never below what it already holds, so nobody is locked
// out the day this runs. Old `maxClients` / `maxDesigns` numbers left in documents from before 2026-11-02 are replaced.
import { Client, Company, Design, Organization, Plan } from '../models/index.js';

export async function migrateOrgCaps() {
  const orgs = await Organization.find({ capsMigrated: { $ne: true } });
  if (!orgs.length) return;
  const plans = new Map((await Plan.find()).map((p) => [String(p._id), p]));
  const defaults = plans.size ? [...plans.values()].find((p) => p.code === 'basic') : null;
  for (const org of orgs) {
    const branches = await Company.find({ organization: org._id }).select('_id planRef').setOptions({ rawBranch: true }).lean();
    const ids = branches.map((b) => b._id);
    const plan = plans.get(String(org.planRef)) || plans.get(String(branches.find((b) => b.planRef)?.planRef)) || defaults;
    const [clients, designs] = await Promise.all([Client.countDocuments({ company: { $in: ids } }), Design.countDocuments({ company: { $in: ids } })]);
    const held = Math.max(1, ids.length);
    await Organization.updateOne({ _id: org._id }, { $set: {
      'limits.maxClients': Math.max(plan?.maxClients || 100, clients),
      'limits.maxDesigns': Math.max(plan?.maxDesigns || 200, designs),
      'limits.maxBranches': Math.max(org.hasBranches ? (plan?.kind === 'custom' ? org.limits?.maxBranches : Math.max(org.limits?.maxBranches || 1, plan?.maxBranches || 1)) : 1, held),
      capsMigrated: true,
    } });
  }
  console.log(`Company-wide caps set for ${orgs.length} companies`);
}

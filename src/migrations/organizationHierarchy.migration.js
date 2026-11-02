import { ROLES } from '../constants/index.js';
import { MASTER_FIELD_KEYS } from '../models/organizationMasters.schema.js';
import { Company, Organization, User } from '../models/index.js';
import { pickCommercialFromCompanyDoc, pickMastersFromCompanyDoc } from '../services/tenant.service.js';

/**
 * One organization per legacy company, set up without branches: its owner becomes role branch and keeps managing
 * the masters (no separate company admin login is made — see constants/tenant.js managesMasters).
 */
export async function migrateOrganizationHierarchy() {
  const branches = await Company.find({ organization: null }).lean();
  if (!branches.length) return;

  let created = 0;
  for (const branch of branches) {
    const org = await Organization.create({
      ...pickCommercialFromCompanyDoc(branch),
      name: branch.name,
      ...pickMastersFromCompanyDoc(branch),
      hasBranches: false,
    });
    await Company.updateOne({ _id: branch._id }, { $set: { organization: org._id } });

    const owners = await User.find({ company: branch._id, role: { $in: [ROLES.COMPANY, ROLES.BRANCH] } });
    for (const owner of owners) {
      if (owner.role === ROLES.COMPANY) {
        owner.role = ROLES.BRANCH;
        await owner.save();
      }
    }

    const branchOwner = await User.findOne({ company: branch._id, role: ROLES.BRANCH });

    if (branchOwner && !branchOwner.organization) {
      branchOwner.organization = org._id;
      await branchOwner.save();
    }

    created++;
  }
  if (created) console.log(`Organization hierarchy: migrated ${created} branch(es)`);
  await backfillOrganizationMaxBranches();
}

/** Ensure every organization has a branch quota (at least as many as existing branches). */
export async function backfillOrganizationMaxBranches() {
  const orgs = await Organization.find().select('limits').lean();
  for (const org of orgs) {
    const used = await Company.countDocuments({ organization: org._id });
    const current = org.limits?.maxBranches;
    const next = Math.max(1, Number(current) || 1, used);
    if (current !== next) {
      await Organization.updateOne({ _id: org._id }, { $set: { 'limits.maxBranches': next } });
    }
  }
}

/** Ensure agents/clients in a branch carry organization ref. */
export async function backfillUserOrganizationRefs() {
  const users = await User.find({ company: { $ne: null }, organization: null, role: { $in: [ROLES.AGENT, ROLES.CLIENT, ROLES.BRANCH] } }).select('company');
  for (const u of users) {
    const branch = await Company.findById(u.company).select('organization').lean();
    if (branch?.organization) await User.updateOne({ _id: u._id }, { $set: { organization: branch.organization } });
  }
}

/** After org masters are authoritative, strip duplicate master blobs from branch docs (optional slimming). */
export async function slimBranchMasterDuplicates() {
  const unset = Object.fromEntries(MASTER_FIELD_KEYS.map((k) => [k, '']));
  await Company.updateMany({ organization: { $ne: null } }, { $unset: unset });
}

// Brings every company in line with how companies are set up now (Organization.hasBranches):
//  - a company without branches has one branch and one sign-in, its owner — no company admin login;
//  - a company with branches has a company admin who signs in with a real email, never a derived "+org" address.
// Runs at every start and changes nothing once the data is consistent.
import { ROLES } from '../constants/index.js';
import { AuthSession, Company, Notification, Organization, User } from '../models/index.js';
import { logger } from '../utils/logger.js';

const DERIVED = /\+org@/i;
const baseEmail = (email) => String(email).replace(/\+org@/i, '@').toLowerCase();

/** Removes logins and everything that only belongs to them (their sessions and inbox). */
async function removeUsers(ids) {
  if (!ids.length) return;
  await Promise.all([AuthSession.deleteMany({ user: { $in: ids } }), Notification.deleteMany({ user: { $in: ids } })]);
  await User.deleteMany({ _id: { $in: ids } });
}

export async function migrateCompanySetup() {
  const orgs = await Organization.collection.find({}, { projection: { name: 1, hasBranches: 1, limits: 1 } }).toArray();
  const log = [];
  for (const org of orgs) {
    const branches = await Company.find({ organization: org._id }).select('_id status createdAt').sort({ createdAt: 1 }).lean();
    let hasBranches = org.hasBranches;
    if (typeof hasBranches !== 'boolean') {
      // made before the choice existed: a company that actually runs several branches has them
      hasBranches = branches.length > 1;
      await Organization.collection.updateOne({ _id: org._id }, { $set: { hasBranches } });
      log.push(`${org.name}: set up ${hasBranches ? 'with' : 'without'} branches`);
    }
    const admins = await User.find({ organization: org._id, role: ROLES.COMPANY }).select('email company').lean();

    if (!hasBranches) {
      if (admins.length) {
        await removeUsers(admins.map((a) => a._id));
        log.push(`${org.name}: removed company admin login(s) ${admins.map((a) => a.email).join(', ')} — the owner runs this company`);
      }
      if (org.limits?.maxBranches !== 1) await Organization.collection.updateOne({ _id: org._id }, { $set: { 'limits.maxBranches': 1 } });
      continue;
    }

    const branchIds = new Set(branches.map((b) => String(b._id)));
    const home = branches.find((b) => b.status === 'active') || branches[0];
    for (const admin of admins) {
      // the admin always works inside one of its own branches
      if (home && !branchIds.has(String(admin.company))) {
        await User.updateOne({ _id: admin._id }, { $set: { company: home._id } });
        log.push(`${org.name}: ${admin.email} moved to an existing branch`);
      }
      if (!DERIVED.test(admin.email)) continue;
      const real = baseEmail(admin.email);
      if (await User.exists({ email: real })) {
        // the real address is someone else's sign-in (usually a branch owner): the platform admin has to choose a new one
        logger.warn('Company admin still signs in with a derived +org email; set a real one under Admin → Companies → Edit', { organization: org.name, email: admin.email });
        continue;
      }
      await User.updateOne({ _id: admin._id }, { $set: { email: real } });
      log.push(`${org.name}: company admin ${admin.email} → ${real}`);
    }
  }
  if (log.length) logger.info('Company setup migration', { changes: log });
}

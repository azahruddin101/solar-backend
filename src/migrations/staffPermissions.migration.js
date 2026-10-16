import { PERMISSIONS_VERSION, upgradePermissions } from '../constants/permissions.js';
import { Role, User } from '../models/index.js';
import { logger } from '../utils/logger.js';

// Staff permissions changed names and were split over time (see PERMISSIONS_VERSION in constants/permissions.js).
// Rewrite every stored permission list — on staff accounts and on roles — to the current names allowing exactly the
// same things, so nobody gains or loses access. Each list is upgraded once: some names exist in several versions
// with a different meaning, so the stored version says where to start.
const stale = { $or: [{ permissionsVersion: { $exists: false } }, { permissionsVersion: { $lt: PERMISSIONS_VERSION } }] };

async function upgrade(Model, what, versionWhenMissing) {
  const rows = await Model.collection.find(stale, { projection: { permissions: 1, permissionsVersion: 1 } }).toArray();
  if (!rows.length) return;
  await Model.collection.bulkWrite(
    rows.map((r) => ({
      updateOne: {
        filter: { _id: r._id },
        update: { $set: { permissions: upgradePermissions(r.permissions, r.permissionsVersion ?? versionWhenMissing), permissionsVersion: PERMISSIONS_VERSION } },
      },
    })),
    { ordered: false },
  );
  logger.info(`Staff permissions upgraded on ${what}`, { count: rows.length, version: PERMISSIONS_VERSION });
}

export async function migrateStaffPermissions() {
  try {
    await upgrade(User, 'accounts', 1); // accounts from before versions existed use the oldest names
    await upgrade(Role, 'roles', 2); // roles arrived with version 2
  } catch (e) {
    logger.warn(`Could not migrate staff permissions: ${e.message}`);
  }
}

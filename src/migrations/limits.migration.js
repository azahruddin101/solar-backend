import { Company, Plan, PlanRequest } from '../models/index.js';

// Plans used to treat 0 as "unlimited". Nothing is unlimited any more, so every stored limit of 0 (or a missing one)
// becomes a real, generous cap. Admins can lower or raise these per plan / company afterwards.
// (clients and proposals are no longer limited at all — only the sign-in cap is filled in here)
const CAPS = { maxConcurrentLogins: 5 };
const low = { $not: { $gte: 1 } }; // 0, missing, or null

export async function capUnlimitedLimits() {
  let changed = 0;
  for (const [field, cap] of Object.entries(CAPS)) {
    changed += (await Plan.collection.updateMany({ [field]: low }, { $set: { [field]: cap } })).modifiedCount;
    changed += (await Company.collection.updateMany({ [`limits.${field}`]: low }, { $set: { [`limits.${field}`]: cap } })).modifiedCount;
    for (const path of ['requestedLimits', 'quotedLimits']) {
      changed += (await PlanRequest.collection.updateMany({ [`${path}.${field}`]: low }, { $set: { [`${path}.${field}`]: cap } })).modifiedCount;
    }
  }
  if (changed) console.log(`Unlimited plan limits replaced with real caps (${CAPS.maxConcurrentLogins} sign-ins): ${changed} values`);
}

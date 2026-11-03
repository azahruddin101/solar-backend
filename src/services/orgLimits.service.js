// The company-wide caps: branches, clients and designs. Clients and designs are counted across ALL of the company's
// branches together (100 designs means 100 between every branch), while each branch still only sees its own records.
// The caps live on the Organization (`limits`), set from its plan or, on a custom plan, by the platform admin.
// Nothing is ever deleted when a cap is lowered: only creating more is refused.
import { Client, Company, Design } from '../models/index.js';
import { badRequest } from '../utils/HttpError.js';

export const ORG_LIMIT_KEYS = ['maxBranches', 'maxClients', 'maxDesigns'];

const LABELS = { clients: ['client', 'clients'], designs: ['design', 'designs'] };
const MODELS = { clients: Client, designs: Design };
const KEYS = { clients: 'maxClients', designs: 'maxDesigns' };

/** Ids of every branch of the company this branch belongs to (just this branch when it has no organization). */
export async function branchIdsOf(company) {
  const org = company?.organization?._id ?? company?.organization ?? null;
  if (!org) return [company._id];
  return Company.find({ organization: org }).select('_id').setOptions({ rawBranch: true }).lean().then((rows) => rows.map((r) => r._id));
}

/** What the whole company holds today: { branches, clients, designs }. */
export async function usageOf(company) {
  const org = company?.organization?._id ?? company?.organization ?? null;
  const ids = await branchIdsOf(company);
  const [clients, designs] = await Promise.all([Client.countDocuments({ company: { $in: ids } }), Design.countDocuments({ company: { $in: ids } })]);
  return { branches: org ? ids.length : 1, clients, designs };
}

/** The caps that apply, from the company's organization (loaded from the branch when `organization` is only an id). */
export async function limitsOf(company) {
  const { Organization } = await import('../models/index.js');
  const org = company?.organization?.limits ? company.organization : (company?.organization ? await Organization.findById(company.organization).select('limits').lean() : null);
  const l = org?.limits || {};
  return { maxBranches: l.maxBranches ?? 1, maxClients: l.maxClients ?? null, maxDesigns: l.maxDesigns ?? null };
}

/**
 * Refuses a new client or design when the company is at its cap. `adding` is how many are about to be created.
 * A company with no recorded cap (not yet migrated) is not limited.
 */
export async function assertWithinCap(company, what, adding = 1) {
  const cap = (await limitsOf(company))[KEYS[what]];
  if (cap == null) return;
  const ids = await branchIdsOf(company);
  const used = await MODELS[what].countDocuments({ company: { $in: ids } });
  if (used + adding > cap) {
    const [one, many] = LABELS[what];
    throw badRequest(`Your company has reached its plan limit of ${cap} ${cap === 1 ? one : many}, counted across all branches. Ask your company admin to upgrade the plan to add more.`);
  }
}

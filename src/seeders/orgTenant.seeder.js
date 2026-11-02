/**
 * Create a demo organization the way the platform admin does (services/organization.service.js):
 *  - `hasBranches` false: one company and one sign-in — `login` is its owner;
 *  - `hasBranches` true: `login` is the company admin, `branchOwner` owns the first branch, and every extra branch
 *    gets its own owner. Then the demo profile and masters are applied.
 */
import { ROLES } from '../constants/index.js';
import { Company, Organization, User } from '../models/index.js';
import { createOrganizationWithBranch } from '../services/organization.service.js';
import { applyOrganizationMasters, pickMastersFromCompanyDoc } from '../services/tenant.service.js';
import { hashPassword } from '../utils/password.js';
import { cleanRichText } from '../utils/richText.js';
import { pick } from '../utils/pick.js';

const PROFILE_ON_BRANCH = ['address', 'website', 'taxId', 'pan', 'phone', 'email'];

/**
 * @returns {{ org, branch, orgAdminEmail: string | null, branchOwnerEmail: string } | null}
 */
export async function seedOrgTenant({ login, company, password, branchName, hasBranches = false, branchOwner = null, maxBranches = 3, extraBranches = [] }) {
  if (await User.exists({ email: login.email })) return null;
  if (hasBranches && !branchOwner?.email) throw new Error(`${company.name}: a company with branches needs a branchOwner with its own email`);

  const { branchId } = await createOrganizationWithBranch({
    name: company.name,
    hasBranches,
    loginEmail: login.email,
    password,
    contactName: login.name,
    branchName: branchName || `${company.name} — Main`,
    branchOwnerEmail: branchOwner?.email,
    branchOwnerName: branchOwner?.name,
    branchOwnerPassword: password,
    phone: company.phone,
    status: company.status || 'active',
    limits: { maxConcurrentLogins: company.limits?.maxConcurrentLogins ?? 2, maxBranches: hasBranches ? maxBranches : 1 },
    notes: company.notes,
  });

  const branch = await Company.findById(branchId);
  const org = await Organization.findById(branch.organization);

  Object.assign(org, pickMastersFromCompanyDoc(company));
  if (company.pdfTerms !== undefined) org.pdfTerms = cleanRichText(company.pdfTerms || '');
  if (company.theme) Object.assign(org.theme, company.theme);
  if (company.currency) org.currency = company.currency;
  if (company.tariff != null) org.tariff = company.tariff;
  if (company.otherCostPerKw != null) org.otherCostPerKw = company.otherCostPerKw;
  if (company.features) Object.assign(org.features, company.features);
  await org.save();

  Object.assign(branch, pick(company, PROFILE_ON_BRANCH));
  branch.status = company.status || 'active';
  applyOrganizationMasters(branch, org);
  await branch.save();

  for (const extra of hasBranches ? extraBranches : []) {
    const name = String(extra.name || '').trim();
    if (!name) continue;
    if (!extra.ownerEmail) throw new Error(`${name}: every branch needs its own owner email`);
    const child = await Company.create({
      organization: org._id,
      name,
      email: extra.email,
      phone: extra.phone,
      status: 'active',
      limits: {
        maxConcurrentLogins: extra.limits?.maxConcurrentLogins ?? 2,
      },
    });
    applyOrganizationMasters(child, org);
    await child.save();
    const ownerEmail = String(extra.ownerEmail).trim().toLowerCase();
    if (!(await User.exists({ email: ownerEmail }))) {
      await User.create({
        email: ownerEmail,
        passwordHash: await hashPassword(extra.ownerPassword || password),
        role: ROLES.BRANCH,
        name: extra.ownerName || '',
        company: child._id,
        organization: org._id,
      });
    }
  }

  return {
    org,
    branch,
    orgAdminEmail: hasBranches ? login.email : null,
    branchOwnerEmail: hasBranches ? branchOwner.email : login.email,
  };
}

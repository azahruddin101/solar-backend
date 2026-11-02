import { ROLES } from './index.js';

/** Company (organization) administrator — manages branches and shared masters. */
export const isOrgAdmin = (user) => user?.role === ROLES.COMPANY;

/** Branch owner — full access within one branch workspace. */
export const isBranchOwner = (user) => user?.role === ROLES.BRANCH;

/** Branch owner or org admin acting in a branch context (same API powers as owner for RBAC). */
export const hasBranchOwnerAccess = (user) => isBranchOwner(user) || isOrgAdmin(user);

/** Whether the organization was set up with branches (Organization.hasBranches — set for every company, see companySetup.migration.js). */
export const orgHasBranches = (org) => org?.hasBranches === true;

/**
 * Who edits the shared masters (installation steps, AMC, loan/subsidy steps, lead form, units, branding…): the company
 * admin, or — in a company without branches, which has no admin above it — its owner.
 */
export const managesMasters = (user, org) => isOrgAdmin(user) || (isBranchOwner(user) && Boolean(org) && !orgHasBranches(org));

/** Legacy alias during transition (prefer isBranchOwner). */
export const isLegacyCompanyOwner = isBranchOwner;

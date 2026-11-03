/**
 * The catalog (parent categories, categories, products) belongs to the organization and is shared by all its
 * branches; stock (batches, serial units) and suppliers stay with each branch. A branch without an organization
 * (legacy) keeps its own catalog.
 */
export const orgIdOf = (company) => company?.organization?._id ?? company?.organization ?? null;
export const catalogOwner = (company) => (orgIdOf(company) ? { organization: orgIdOf(company) } : { company: company._id });
/** Fields for a new catalog document: owned by the organization, `company` records the branch it was created in. */
export const catalogOwnerFields = (company) => ({ company: company._id, organization: orgIdOf(company) });

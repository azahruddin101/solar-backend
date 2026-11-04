// Everything that belongs to one company, in one place: deleting a company removes each of these, and
// tests/companyDelete.test.js fails when a model with a `company` field is in neither list, so a new collection can't be
// forgotten (it would otherwise keep a deleted company's client and money data).
import {
  AuthSession, Batch, Bill, CreditNote, Category, Client, ClientTicket, Counter, Design, DesignVersion, EmailLog, Estimate, EwayBill, Expense,
  InstallationCharge, Invoice, Loan, Subsidy, Notification, Package, ParentCategory, Payment, Plan, PlanRequest, Product, Project, ProjectBudget,
  Role, SerialUnit, Supplier, Ticket, User, Company,
} from '../models/index.js';
import { FileShare } from '../models/fileShare.model.js';
import { leadCompanyModels } from '../integrations/leads.js';

/** Models deleted with `{ company: id }`. */
export const COMPANY_SCOPED_MODELS = [
  Project, Design, DesignVersion, Client, Batch, SerialUnit, Supplier, Package, InstallationCharge, Estimate,
  EwayBill, Bill, CreditNote, Payment, Invoice, Counter, Loan, Subsidy, Expense, ProjectBudget, Role, FileShare, EmailLog, PlanRequest, AuthSession, Notification,
  User, ...leadCompanyModels,
];

/** Company-scoped models that are removed some other way, and a model with a `company` field that is not removed at all. */
export const REMOVED_ELSEWHERE = new Map([
  [Ticket, 'deleteTicketsForCompany (deletes the attachments first)'],
  [ClientTicket, 'deleteClientTicketsForCompany (deletes the attachments first)'],
  [Product, 'removeBranchCatalog (the catalog is shared by the organization)'],
  [Category, 'removeBranchCatalog (the catalog is shared by the organization)'],
  [ParentCategory, 'removeBranchCatalog (the catalog is shared by the organization)'],
]);

const CATALOG_MODELS = [Product, Category, ParentCategory];

/**
 * The catalog belongs to the organization: deleting one branch keeps it for the others (what this branch created is
 * handed to another branch); it goes only with the organization's last branch.
 */
async function removeBranchCatalog(companyId) {
  const branch = await Company.findById(companyId).select('organization').setOptions({ rawBranch: true }).lean();
  const orgId = branch?.organization;
  const heir = orgId ? await Company.findOne({ organization: orgId, _id: { $ne: companyId } }).select('_id').sort({ createdAt: 1 }).setOptions({ rawBranch: true }).lean() : null;
  if (heir) {
    await Promise.all(CATALOG_MODELS.map((M) => M.updateMany({ company: companyId }, { company: heir._id })));
    return;
  }
  const filter = orgId ? { $or: [{ company: companyId }, { organization: orgId }] } : { company: companyId };
  await Promise.all(CATALOG_MODELS.map((M) => M.deleteMany(filter)));
}

/**
 * Remove every document of the company. Notifications and sign-in sessions are matched by the company and also by its
 * users, since some were written without a company. The company's own custom plan offers go too.
 */
export async function deleteCompanyData(companyId) {
  const filter = { company: companyId };
  const userIds = await User.distinct('_id', filter);
  await removeBranchCatalog(companyId); // before the branch document itself is gone
  await Promise.all([
    ...COMPANY_SCOPED_MODELS.filter((M) => M !== Notification && M !== AuthSession).map((M) => M.deleteMany(filter)),
    Notification.deleteMany({ $or: [filter, { user: { $in: userIds } }] }),
    AuthSession.deleteMany({ $or: [filter, { user: { $in: userIds } }] }),
    Plan.deleteMany({ forCompany: companyId }),
  ]);
}

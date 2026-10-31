// Everything that belongs to one company, in one place: deleting a company removes each of these, and
// tests/companyDelete.test.js fails when a model with a `company` field is in neither list, so a new collection can't be
// forgotten (it would otherwise keep a deleted company's client and money data).
import {
  AuthSession, Batch, Bill, CreditNote, Category, Client, ClientTicket, Counter, Design, DesignVersion, EmailLog, EwayBill, Expense,
  InstallationCharge, Invoice, Loan, Subsidy, Notification, Package, ParentCategory, Payment, Plan, PlanRequest, Product, Project, ProjectBudget,
  Role, SerialUnit, Supplier, Ticket, User,
} from '../models/index.js';
import { FileShare } from '../models/fileShare.model.js';
import { leadCompanyModels } from '../integrations/leads.js';

/** Models deleted with `{ company: id }`. */
export const COMPANY_SCOPED_MODELS = [
  Project, Design, DesignVersion, Client, Product, Batch, SerialUnit, Supplier, Category, ParentCategory, Package, InstallationCharge,
  EwayBill, Bill, CreditNote, Payment, Invoice, Counter, Loan, Subsidy, Expense, ProjectBudget, Role, FileShare, EmailLog, PlanRequest, AuthSession, Notification,
  User, ...leadCompanyModels,
];

/** Company-scoped models that are removed some other way, and a model with a `company` field that is not removed at all. */
export const REMOVED_ELSEWHERE = new Map([
  [Ticket, 'deleteTicketsForCompany (deletes the attachments first)'],
  [ClientTicket, 'deleteClientTicketsForCompany (deletes the attachments first)'],
]);

/**
 * Remove every document of the company. Notifications and sign-in sessions are matched by the company and also by its
 * users, since some were written without a company. The company's own custom plan offers go too.
 */
export async function deleteCompanyData(companyId) {
  const filter = { company: companyId };
  const userIds = await User.distinct('_id', filter);
  await Promise.all([
    ...COMPANY_SCOPED_MODELS.filter((M) => M !== Notification && M !== AuthSession).map((M) => M.deleteMany(filter)),
    Notification.deleteMany({ $or: [filter, { user: { $in: userIds } }] }),
    AuthSession.deleteMany({ $or: [filter, { user: { $in: userIds } }] }),
    Plan.deleteMany({ forCompany: companyId }),
  ]);
}

import { Company, Design, Loan } from '../models/index.js';
import { openLoanForDesign } from '../services/loan.service.js';
import { logger } from '../utils/logger.js';

// Loans belong to a proposal (one per proposal). The first version kept one per client: drop its unique client index,
// move any such loan onto the client's latest proposal, and open a loan for every proposal already marked "Loan".
export async function migrateLoans() {
  try {
    const old = (await Loan.collection.indexes()).find((i) => i.name === 'client_1' && i.unique);
    if (old) await Loan.collection.dropIndex('client_1');
    await Loan.createIndexes();

    for (const loan of await Loan.find({ design: { $exists: false } })) {
      const design = await Design.findOne({ company: loan.company, client: loan.client }).sort({ createdAt: -1 }).select('_id');
      if (design && !(await Loan.exists({ design: design._id }))) {
        await Loan.updateOne({ _id: loan._id }, { design: design._id });
        await Design.updateOne({ _id: design._id }, { loanRequired: true });
      } else if (loan.steps.every((s) => s.status === 'pending') && !loan.lender && !loan.amount) {
        await Loan.deleteOne({ _id: loan._id });
      } else {
        logger.warn('Loan has no proposal to move to; left as is', { loan: String(loan._id) });
      }
    }

    const withLoan = await Loan.distinct('design');
    const missing = await Design.find({ loanRequired: true, _id: { $nin: withLoan } }).select('company client');
    const companies = new Map();
    for (const design of missing) {
      const key = String(design.company);
      if (!companies.has(key)) companies.set(key, await Company.findById(design.company).select('loanSteps'));
      if (companies.get(key)) await openLoanForDesign(companies.get(key), design, null);
    }
  } catch (e) {
    console.warn(`Could not migrate loans: ${e.message}`);
  }
}

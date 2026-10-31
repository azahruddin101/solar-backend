// The ready-made filters the dashboard links to (`?show=` on the proposal and installation lists). Each one matches
// exactly what the dashboard counts in dashboard.service today(), so a "2 quotes with no reply" link lists those 2.
import { OPEN_DESIGN_STATUS } from '../constants/index.js';
import { Loan, Project, Subsidy } from '../models/index.js';

const DAY = 24 * 60 * 60 * 1000;
const startOfDay = (now) => new Date(now.getFullYear(), now.getMonth(), now.getDate());
const startOfMonth = (now) => new Date(now.getFullYear(), now.getMonth(), 1);

export const DESIGN_SHOWS = ['changes', 'no_reply', 'expiring', 'not_started', 'loan_missing', 'subsidy_missing', 'made_month'];
export const PROJECT_SHOWS = ['stuck', 'unassigned', 'finished_month'];

/** Extra Mongo conditions on Design for a `show` preset; null for an unknown or empty one (no filter). */
export async function designShowMatch(company, show, now = new Date()) {
  const week = new Date(now.getTime() - 7 * DAY);
  const today = startOfDay(now);
  switch (show) {
    case 'changes': // the client asked for changes on a quote
      return { status: { $in: OPEN_DESIGN_STATUS }, 'clientResponse.decision': 'changes_requested' };
    case 'no_reply': // sent, no answer from the client, nobody has touched it for a week
      return { status: { $in: OPEN_DESIGN_STATUS }, 'clientResponse.decision': null, updatedAt: { $lt: week } };
    case 'expiring': // the quoted price holds for 7 days or less (today included)
      return { status: { $in: OPEN_DESIGN_STATUS }, validUntil: { $gte: today, $lt: new Date(today.getTime() + 8 * DAY) } };
    case 'not_started': // booked, no installation yet
      return { status: 'won', _id: { $nin: await Project.distinct('design', { company: company._id }) } };
    case 'loan_missing': // booked on a loan, no loan file opened
      return { status: 'won', loanRequired: true, _id: { $nin: await Loan.distinct('design', { company: company._id }) } };
    case 'subsidy_missing': // booked with a subsidy, no subsidy file opened
      return { status: 'won', 'subsidy.enabled': true, _id: { $nin: await Subsidy.distinct('design', { company: company._id }) } };
    case 'made_month': // created since the 1st of this month
      return { createdAt: { $gte: startOfMonth(now) } };
    default:
      return null;
  }
}

/** Extra Mongo conditions on Project for a `show` preset; null for an unknown or empty one (no filter). */
export function projectShowMatch(show, now = new Date()) {
  switch (show) {
    case 'stuck': // a step started more than a week ago and still not done
      return { status: 'active', steps: { $elemMatch: { status: 'in_progress', startedAt: { $lt: new Date(now.getTime() - 7 * DAY) } } } };
    case 'unassigned': // a step still to do with nobody on it
      return { status: 'active', steps: { $elemMatch: { status: { $ne: 'done' }, assignee: null } } };
    case 'finished_month': // installation completed since the 1st of this month
      return { installationCompletedAt: { $gte: startOfMonth(now) } };
    default:
      return null;
  }
}

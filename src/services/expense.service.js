// Expenses: the amount spent on each proposal's project and why, measured against the budget set for it.
// Profit / loss is simply budget − expenses: what's left of the budget is profit, going over it is a loss.
import { Design, Expense, ProjectBudget } from '../models/index.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { objectId } from '../utils/validators.js';

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function ownDesign(company, id) {
  const design = await Design.findOne({ _id: objectId(id, 'Proposal'), company: company._id }).select('name status client').populate('client', 'name');
  if (!design) throw notFound('Proposal');
  return design;
}

function parseDate(value) {
  if (value === undefined || value === null || value === '') return new Date();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest('Enter a valid date');
  return d;
}

/** Budget usage in percent (null without a budget). */
const usedOf = (spent, budget) => (budget > 0 ? Math.round((spent / budget) * 1000) / 10 : null);

/** Budget − expenses (null without a budget): positive is profit, negative is loss. */
const profitOf = (spent, budget) => (budget !== null && budget !== undefined ? money(budget - spent) : null);

const budgetJSON = (b) => (b ? { amount: money(b.amount), note: b.note || '', updatedByName: b.updatedByName || '', updatedAt: b.updatedAt } : null);

/** Per project: what was spent, how many entries, the latest one and the budget. Booked proposals and any with expenses or a budget. */
async function projectRows(company) {
  const [sums, budgets] = await Promise.all([
    Expense.aggregate([
      { $match: { company: company._id } },
      { $group: { _id: '$design', spent: { $sum: '$amount' }, count: { $sum: 1 }, last: { $max: '$spentOn' } } },
    ]),
    ProjectBudget.find({ company: company._id }).select('design amount').lean(),
  ]);
  const byDesign = new Map(sums.map((s) => [String(s._id), s]));
  const budgetOf = new Map(budgets.map((b) => [String(b.design), b.amount]));
  const ids = [...sums.map((s) => s._id), ...budgets.map((b) => b.design)];
  const designs = await Design.find({ company: company._id, $or: [{ status: 'won' }, { _id: { $in: ids } }] })
    .select('name status client summary.address')
    .populate('client', 'name')
    .sort({ updatedAt: -1 })
    .limit(1000);
  return designs.map((d) => {
    const s = byDesign.get(d.id);
    const spent = money(s?.spent);
    const budget = budgetOf.has(d.id) ? money(budgetOf.get(d.id)) : null;
    return {
      id: d.id,
      name: d.name,
      status: d.status,
      address: d.summary?.address || '',
      client: d.client ? { id: d.client.id, name: d.client.name } : null,
      spent,
      count: s?.count || 0,
      lastExpenseOn: s?.last || null,
      budget,
      budgetUsed: usedOf(spent, budget),
      profit: profitOf(spent, budget),
    };
  });
}

/** How many projects the expenses list shows (the sidebar count): booked proposals and any with expenses or a budget. */
export async function projectCount(company) {
  const [spentOn, budgeted] = await Promise.all([
    Expense.distinct('design', { company: company._id }),
    ProjectBudget.distinct('design', { company: company._id }),
  ]);
  return Math.min(1000, await Design.countDocuments({ company: company._id, $or: [{ status: 'won' }, { _id: { $in: [...spentOn, ...budgeted] } }] }));
}

/** Every booked proposal (and any other that has expenses or a budget) with what has been spent on it. */
export async function overview(company, { q } = {}) {
  const term = String(q ?? '').trim().toLowerCase().slice(0, 100);
  const items = (await projectRows(company)).filter((r) => !term || `${r.name} ${r.client?.name || ''} ${r.address}`.toLowerCase().includes(term));
  return { items, totalSpent: money(items.reduce((a, r) => a + r.spent, 0)), totalBudget: money(items.reduce((a, r) => a + (r.budget || 0), 0)) };
}

/** One proposal with its expenses (newest first), budget and profit / loss against it. */
export async function listForDesign(company, designId) {
  const design = await ownDesign(company, designId);
  const [rows, budget] = await Promise.all([
    Expense.find({ company: company._id, design: design._id }).sort({ spentOn: -1, createdAt: -1 }),
    ProjectBudget.findOne({ company: company._id, design: design._id }).lean(),
  ]);
  const total = money(rows.reduce((a, e) => a + e.amount, 0));
  return {
    design: { id: design.id, name: design.name, status: design.status, client: design.client ? { id: design.client.id, name: design.client.name } : null },
    items: rows.map((e) => e.toJSON()),
    total,
    budget: budgetJSON(budget),
    budgetUsed: usedOf(total, budget?.amount),
    profit: profitOf(total, budget ? budget.amount : null),
  };
}

/** Set (or change) the project's budget. */
export async function setBudget(company, user, designId, body) {
  const design = await ownDesign(company, designId);
  const budget = await ProjectBudget.findOneAndUpdate(
    { company: company._id, design: design._id },
    { $set: { amount: money(body.amount), note: String(body.note ?? '').trim(), updatedByName: user.name || user.email || '' } },
    { upsert: true, returnDocument: 'after', runValidators: true },
  ).lean();
  return budgetJSON(budget);
}

export async function removeBudget(company, designId) {
  const design = await ownDesign(company, designId);
  await ProjectBudget.deleteOne({ company: company._id, design: design._id });
}

const ANALYTICS_MONTHS = [6, 12, 24];
const TOP_REASONS = 7; // the rest fold into "Other"

/** "2026-10" for each of the last `span` months, oldest first (UTC, like the grouping below). */
function monthKeys(span) {
  const now = new Date();
  return Array.from({ length: span }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (span - 1 - i), 1)).toISOString().slice(0, 7));
}

/**
 * Profit & loss across projects (budget − expenses, lifetime), plus spending per month and by reason over the last
 * `months` months.
 */
export async function analytics(company, { months } = {}) {
  const span = ANALYTICS_MONTHS.includes(Number(months)) ? Number(months) : 12;
  const keys = monthKeys(span);
  const since = new Date(`${keys[0]}-01T00:00:00Z`);

  const [projects, monthlyRows, reasonRows] = await Promise.all([
    projectRows(company),
    Expense.aggregate([{ $match: { company: company._id, spentOn: { $gte: since } } }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$spentOn' } }, sum: { $sum: '$amount' } } }]),
    Expense.aggregate([{ $match: { company: company._id, spentOn: { $gte: since } } }, { $group: { _id: '$reason', sum: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { sum: -1 } }]),
  ]);

  const sum = (rows, k) => money(rows.reduce((a, r) => a + (r[k] || 0), 0));
  const budgeted = projects.filter((p) => p.budget !== null);
  const totals = {
    projects: projects.length,
    budgeted: budgeted.length,
    budget: sum(budgeted, 'budget'),
    spent: sum(projects, 'spent'),
    spentAgainstBudget: sum(budgeted, 'spent'),
    profit: sum(budgeted, 'profit'),
    overBudget: budgeted.filter((p) => p.profit < 0).length,
  };

  const spentIn = new Map(monthlyRows.map((r) => [r._id, r.sum]));
  const monthly = keys.map((month) => ({ month, spent: money(spentIn.get(month)) }));

  const byReason = reasonRows.slice(0, TOP_REASONS).map((r) => ({ reason: r._id, amount: money(r.sum), count: r.count }));
  const rest = reasonRows.slice(TOP_REASONS);
  if (rest.length) byReason.push({ reason: 'Other', amount: money(rest.reduce((a, r) => a + r.sum, 0)), count: rest.reduce((a, r) => a + r.count, 0), other: true });

  return { months: span, totals, projects, monthly, byReason };
}

export async function create(company, user, designId, body) {
  const design = await ownDesign(company, designId);
  const expense = await Expense.create({
    company: company._id,
    design: design._id,
    amount: money(body.amount),
    reason: String(body.reason).trim(),
    note: String(body.note ?? '').trim(),
    spentOn: parseDate(body.spentOn),
    createdBy: user._id,
    createdByName: user.name || user.email || '',
  });
  return expense.toJSON();
}

async function ownExpense(company, id) {
  const expense = await Expense.findOne({ _id: objectId(id, 'Expense'), company: company._id });
  if (!expense) throw notFound('Expense');
  return expense;
}

export async function update(company, id, body) {
  const expense = await ownExpense(company, id);
  if (body.amount !== undefined) expense.amount = money(body.amount);
  if (body.reason !== undefined) expense.reason = String(body.reason).trim();
  if (body.note !== undefined) expense.note = String(body.note ?? '').trim();
  if (body.spentOn !== undefined) expense.spentOn = parseDate(body.spentOn);
  await expense.save();
  return expense.toJSON();
}

export async function remove(company, id) {
  const expense = await ownExpense(company, id);
  await expense.deleteOne();
}

export async function deleteForDesign(designId) {
  await Promise.all([Expense.deleteMany({ design: designId }), ProjectBudget.deleteMany({ design: designId })]);
}


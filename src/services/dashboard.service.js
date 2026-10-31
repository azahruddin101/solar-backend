// The company dashboard: sales pipeline, money collected and what needs attention — one company-scoped read.
import { DEFAULT_PRODUCT_UNITS, DESIGN_STATUS, OPEN_DESIGN_STATUS, ROLES } from '../constants/index.js';
import { Batch, Bill, Category, Client, ClientTicket, Design, EwayBill, Expense, InstallationCharge, Invoice, Loan, Subsidy, Package, Payment, Product, Project, SerialUnit, Supplier, Ticket, User } from '../models/index.js';
import { warrantyEndDate } from '../models/serialUnit.model.js';
import { totalOf } from './billing.service.js';
import { agentRolesList } from './company.service.js';
import { amcTrackerCount, daysUntilDue, listAmcVisits } from './amc.service.js';
import { stockSummary } from './stock.service.js';
import { clientTicketOpenCountForCompany } from './clientTicket.service.js';
import { leadAssignmentModel, leadModels } from '../integrations/leads.js';
import { hasPermission } from '../middlewares/auth.middleware.js';
import { projectCount as expenseProjectCount } from './expense.service.js';

const DAY = 24 * 60 * 60 * 1000;
const round = (v) => Math.round((Number(v) || 0) * 100) / 100;
const STATUSES = DESIGN_STATUS;
const isOpen = (d) => OPEN_DESIGN_STATUS.includes(d.status);

/** The last `n` calendar months, oldest first: [{ key: '2026-04', label: 'Apr 2026' }, …]. */
function lastMonths(n, now = new Date()) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (n - 1 - i), 1);
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }), start: d };
  });
}

export async function dashboard(company) {
  const now = new Date();
  const months = lastMonths(12, now);
  const since = months[0].start;

  const [clients, designs, payments, invoices] = await Promise.all([
    Client.countDocuments({ company: company._id }),
    Design.find({ company: company._id }).select('-data -logs').populate('client', 'name').lean(),
    Payment.find({ company: company._id }).sort({ receivedOn: -1 }).populate('client', 'name').populate('design', 'name').lean(),
    Invoice.find({ company: company._id, status: { $ne: 'void' }, kind: { $ne: 'amc_parts' }, design: { $ne: null } }).select('design invoiceNo issuedOn total').lean(),
  ]);

  // pipeline: how many proposals and how much money sit in each stage
  const stages = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, value: 0, kwp: 0 }]));
  for (const d of designs) {
    const s = stages[d.status] || stages.draft;
    s.count += 1;
    s.value += totalOf(d);
    s.kwp += d.summary?.kwp || 0;
  }
  for (const s of Object.values(stages)) Object.assign(s, { value: round(s.value), kwp: round(s.kwp) });
  const decided = stages.won.count + stages.lost.count;

  // money: what each won proposal is worth and how much has come in
  const paidBy = new Map();
  for (const p of payments) paidBy.set(String(p.design?._id || p.design), (paidBy.get(String(p.design?._id || p.design)) || 0) + p.amount);
  const invoiceOf = new Map();
  for (const i of [...invoices].sort((a, b) => new Date(b.createdAt || b.issuedOn) - new Date(a.createdAt || a.issuedOn))) {
    const k = String(i.design);
    if (!invoiceOf.has(k)) invoiceOf.set(k, i);
  }
  const won = designs.filter((d) => d.status === 'won').map((d) => {
    const total = totalOf(d);
    const paid = round(paidBy.get(String(d._id)) || 0);
    const lastPayment = payments.find((p) => String(p.design?._id) === String(d._id));
    return { id: String(d._id), name: d.name, client: d.client?.name || '', total, paid, balance: round(total - paid), invoiceNo: invoiceOf.get(String(d._id))?.invoiceNo || '', lastPaymentOn: lastPayment?.receivedOn || null, wonOn: d.updatedAt };
  });
  // booked value against what the chain has billed (every bill is paid when it is made). Billing more than the quote is
  // allowed, so what is left to bill never goes below zero for a proposal and the surplus is not netted off the others.
  const quoted = round(won.reduce((a, w) => a + w.total, 0));
  const billed = round(won.reduce((a, w) => a + w.paid, 0));
  const yetToBill = round(won.reduce((a, w) => a + Math.max(0, w.balance), 0));

  // received per month (12 months) and the month-on-month change
  const perMonth = new Map(months.map((m) => [m.key, { amount: 0, count: 0 }]));
  for (const p of payments) {
    if (p.receivedOn < since) continue;
    const d = new Date(p.receivedOn);
    const cell = perMonth.get(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    if (cell) {
      cell.amount += p.amount;
      cell.count += 1;
    }
  }
  const revenue = months.map((m) => ({ key: m.key, label: m.label, amount: round(perMonth.get(m.key).amount), count: perMonth.get(m.key).count }));

  // proposals created / won per month (last 6) — is the pipeline being fed?
  const recent = months.slice(-6);
  const activity = recent.map((m) => {
    const next = new Date(m.start.getFullYear(), m.start.getMonth() + 1, 1);
    const inMonth = (d) => d.createdAt >= m.start && d.createdAt < next;
    return { key: m.key, label: m.label, created: designs.filter(inMonth).length, won: designs.filter((d) => inMonth(d) && d.status === 'won').length };
  });

  const week = new Date(now.getTime() - 7 * DAY);
  return {
    generatedAt: now,
    totals: { clients, proposals: designs.length, kwp: round(designs.reduce((a, d) => a + (d.summary?.kwp || 0), 0)), wonKwp: stages.won.kwp },
    stages,
    winRate: decided ? Math.round((stages.won.count / decided) * 100) : null,
    averageDeal: stages.won.count ? round(stages.won.value / stages.won.count) : 0,
    money: { quoted, billed, yetToBill, billedPct: quoted ? Math.min(100, Math.round((billed / quoted) * 100)) : 0 },
    revenue,
    thisMonth: revenue.at(-1).amount,
    lastMonth: revenue.at(-2)?.amount || 0,
    activity,
    attention: {
      // client asked for changes on a proposed design
      clientChanges: designs
        .filter((d) => isOpen(d) && d.clientResponse?.decision === 'changes_requested')
        .sort((a, b) => new Date(b.clientResponse.respondedAt || b.updatedAt) - new Date(a.clientResponse.respondedAt || a.updatedAt))
        .slice(0, 5)
        .map((d) => ({
          id: String(d._id),
          name: d.name,
          type: d.type,
          client: d.client?.name || '',
          note: d.clientResponse?.note || '',
          value: totalOf(d),
          respondedAt: d.clientResponse?.respondedAt || d.updatedAt,
        })),
      // proposals sent to the client that nobody has moved for a week
      followUp: designs.filter((d) => isOpen(d) && !d.clientResponse?.decision && new Date(d.updatedAt) < week).sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt)).slice(0, 5).map((d) => ({ id: String(d._id), name: d.name, type: d.type, client: d.client?.name || '', value: totalOf(d), updatedAt: d.updatedAt })),
      // booked proposals with a price but no invoice yet
      invoice: won.filter((w) => w.total > 0 && !w.invoiceNo).slice(0, 5),
    },
    recentPayments: payments.slice(0, 6).map((p) => ({ id: String(p._id), receiptNo: p.receiptNo, amount: p.amount, mode: p.mode, receivedOn: p.receivedOn, client: p.client?.name || '', design: p.design?.name || '', designId: String(p.design?._id || '') })),
    recentProposals: [...designs].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 6).map((d) => ({ id: String(d._id), name: d.name, type: d.type, status: d.status, client: d.client?.name || '', kwp: d.summary?.kwp || 0, panels: d.summary?.panels || 0, value: totalOf(d), updatedAt: d.updatedAt })),
  };
}

const CO2_KG_PER_KWH = 0.7; // the factor the proposal PDF uses
const daysSince = (date, now) => Math.max(0, Math.floor((now - new Date(date)) / DAY));
const LEAD_SOURCES = [
  { key: 'meta', label: 'Facebook / Instagram', live: { processingStatus: 'processed' }, contacted: 'adminStatus' },
  { key: 'google', label: 'Google Ads', live: {}, contacted: 'status' },
  { key: 'manual', label: 'Added by your team', live: {}, contacted: 'status' },
];

/**
 * The owner's first screen (/api/dashboard/today): what needs doing today, who owes money and for how long, where leads
 * come from and where installations stand — counts plus a few rows each, read from existing records. Money totals,
 * the monthly chart and the proposal queues stay in dashboard().
 */
export async function today(company) {
  const now = new Date();
  const filter = { company: company._id };
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAhead = new Date(startOfToday.getTime() + 8 * DAY); // through the end of the 7th day from today
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const since90 = new Date(now.getTime() - 90 * DAY);
  const stuckBefore = new Date(now.getTime() - 7 * DAY);
  const months = lastMonths(12, now);
  const monthKey = (date) => `${new Date(date).getFullYear()}-${String(new Date(date).getMonth() + 1).padStart(2, '0')}`;
  const leadMonths = LEAD_SOURCES.map((s) => leadModels[s.key].aggregate([
    { $match: { ...filter, isDeleted: false, ...s.live, createdAt: { $gte: months[6].start } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Asia/Kolkata' } }, n: { $sum: 1 } } },
  ]));

  const leadCounts = LEAD_SOURCES.flatMap((s) => {
    const model = leadModels[s.key];
    const live = { ...filter, isDeleted: false, ...s.live };
    const recent = { ...live, createdAt: { $gte: since90 } };
    return [
      model.countDocuments({ ...live, assignedTo: null }),
      model.countDocuments(recent),
      model.countDocuments({ ...recent, [s.contacted]: { $ne: null } }),
      model.countDocuments({ ...recent, convertedClient: { $ne: null } }),
    ];
  });

  // every live lead by its current status, as the lead list shows and filters it: a Meta lead's status is its
  // telecaller's (active assignment), else the admin's; Google and manual leads carry their own
  const leadStatusGroups = Promise.all([
    leadModels.meta.aggregate([
      { $match: { ...filter, isDeleted: false, processingStatus: 'processed' } },
      { $lookup: { from: leadAssignmentModel.collection.name, let: { lead: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$lead', '$$lead'] }, isActive: true } }, { $project: { currentStatus: 1 } }], as: 'assignment' } },
      { $group: { _id: { status: { $ifNull: [{ $arrayElemAt: ['$assignment.currentStatus', 0] }, '$adminStatus'] }, to: '$assignedTo' }, n: { $sum: 1 } } },
    ]),
    leadModels.google.aggregate([{ $match: { ...filter, isDeleted: false } }, { $group: { _id: { status: '$status', to: '$assignedTo' }, n: { $sum: 1 } } }]),
    leadModels.manual.aggregate([{ $match: { ...filter, isDeleted: false } }, { $group: { _id: { status: '$status', to: '$assignedTo' }, n: { $sum: 1 } } }]),
    leadModels.status.find(filter).select('name color order outcome isDeleted').sort({ order: 1, createdAt: 1 }).lean(),
  ]);

  const [amc, designs, projects, loans, subsidies, products, batches, installedUnits, spent, payments, invoiced, expenses, ticketsOpen, ticketsUnread, statusGroups, ...rest] = await Promise.all([
    listAmcVisits(company),
    Design.find(filter).select('name type status client clientResponse validUntil loanRequired subsidy summary updatedAt').populate('client', 'name').lean(),
    Project.find(filter).select('design client status steps installationCompletedAt createdAt').populate('design', 'name').populate('client', 'name').populate('steps.assignee', 'name').lean(),
    Loan.find(filter).select('design status amount').lean(),
    Subsidy.find(filter).select('design status centralAmount stateAmount receivedAmount').lean(),
    Product.find(filter).select('name reorderLevel unit category').populate('category', 'name').lean(),
    Batch.find({ ...filter, $or: [{ qtyRemaining: { $gt: 0 } }, { receivedDate: { $gte: months[6].start } }] }).select('product qtyReceived qtyRemaining purchasePrice basePrice receivedDate').lean(),
    SerialUnit.find({ ...filter, status: 'installed', installDate: { $ne: null } }).select('product serialNo installDate installedProject').populate('product', 'name warrantyMonths').populate({ path: 'installedProject', select: 'client', populate: { path: 'client', select: 'name' } }).lean(),
    Expense.aggregate([{ $match: { ...filter, spentOn: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Payment.find(filter).select('design amount mode receivedOn').lean(),
    Invoice.distinct('design', { ...filter, status: { $ne: 'void' }, kind: { $ne: 'amc_parts' }, design: { $ne: null } }),
    Expense.find({ ...filter, spentOn: { $gte: months[0].start } }).select('amount spentOn').lean(),
    clientTicketOpenCountForCompany(company._id),
    ClientTicket.countDocuments({ ...filter, teamUnread: { $gt: 0 } }),
    leadStatusGroups,
    ...leadCounts,
    ...leadMonths,
  ]);
  const leadNumbers = rest.slice(0, leadCounts.length);
  const leadsByMonth = rest.slice(leadCounts.length);

  // open, scheduled service visits — counted as the AMC board counts them, so its "Due today" / "Overdue" lists match
  const scheduled = amc.items.filter((v) => v.status !== 'completed' && v.booked && v.daysLeft != null);
  const visits = scheduled.filter((v) => v.daysLeft <= 0).sort((a, b) => a.daysLeft - b.daysLeft);

  const won = designs.filter((d) => d.status === 'won');

  // quotes: the client asked for changes, nobody has heard back in a week, or the price holds for 7 days or less
  const open = designs.filter(isOpen);
  const changes = open.filter((d) => d.clientResponse?.decision === 'changes_requested').length;
  const noReply = open.filter((d) => !d.clientResponse?.decision && d.updatedAt < stuckBefore).length;
  const proposed = open.filter((d) => d.validUntil);
  const expiring = proposed
    .filter((d) => d.validUntil >= startOfToday && d.validUntil < weekAhead)
    .sort((a, b) => a.validUntil - b.validUntil)
    .map((d) => ({ id: String(d._id), name: d.name, type: d.type, client: d.client?.name || '', value: totalOf(d), validUntil: d.validUntil, daysLeft: daysUntilDue(d.validUntil, now) }));

  // installations: the step each active one is on, steps nobody is doing, steps that stopped moving
  const projectOf = new Set(projects.map((p) => String(p.design?._id || p.design)));
  const active = projects.filter((p) => p.status === 'active');
  const atStep = new Map();
  let unassignedSteps = 0;
  const stuck = [];
  for (const p of active) {
    const steps = p.steps || [];
    const i = steps.findIndex((s) => s.status !== 'done');
    const key = i === -1 ? 'All steps done' : steps[i].name;
    const cell = atStep.get(key) || { step: key, count: 0, order: i === -1 ? Infinity : i };
    cell.count += 1;
    cell.order = Math.min(cell.order, i === -1 ? Infinity : i);
    atStep.set(key, cell);
    for (const s of steps) {
      if (s.status === 'done') continue;
      if (!s.assignee) unassignedSteps += 1;
      if (s.status === 'in_progress' && s.startedAt && s.startedAt < stuckBefore) {
        stuck.push({ projectId: String(p._id), project: p.design?.name || '', client: p.client?.name || '', step: s.name, assignee: s.assignee?.name || '', days: daysSince(s.startedAt, now) });
      }
    }
  }
  const finished = projects.filter((p) => p.installationCompletedAt);
  const recentFinished = finished.filter((p) => p.installationCompletedAt >= new Date(now.getTime() - 180 * DAY));
  const notStarted = won.filter((d) => !projectOf.has(String(d._id)));
  const hasInvoice = new Set(invoiced.map(String));
  const noInvoice = won.filter((d) => totalOf(d) > 0 && !hasInvoice.has(String(d._id))).length;

  // booked on a loan with no loan file opened
  const loanFor = new Set(loans.map((l) => String(l.design)));
  const loanMissing = won.filter((d) => d.loanRequired && !loanFor.has(String(d._id)));
  const loansOpen = loans.filter((l) => l.status === 'in_progress');
  // booked with a subsidy and no subsidy file opened
  const subsidyFor = new Set(subsidies.map((s) => String(s.design)));
  const subsidyMissing = won.filter((d) => d.subsidy?.enabled && !subsidyFor.has(String(d._id)));
  const subsidiesOpen = subsidies.filter((s) => s.status === 'in_progress');

  const stock = await stockSummary(company._id, products.map((p) => p._id));
  const stocked = products.map((p) => ({ id: String(p._id), name: p.name, unit: p.unit || '', category: p.category?.name || 'No category', reorderLevel: p.reorderLevel || 0, stock: stock.get(String(p._id))?.stock || 0 }));
  // the catalog's own badges: no stock left is "Out of stock"; some, at or below the reorder level, is "Low stock"
  const outOfStock = stocked.filter((p) => p.stock <= 0);
  const lowStock = stocked.filter((p) => p.stock > 0 && p.stock <= p.reorderLevel);
  const needsStock = [...outOfStock, ...lowStock].sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name));

  // what the stock on the shelf cost, by category, and what came in each month (at purchase price, else base price)
  const cost = (b) => b.purchasePrice || b.basePrice || 0;
  const categoryOf = new Map(stocked.map((p) => [p.id, p.category]));
  const valueBy = new Map();
  const receivedBy = new Map();
  for (const b of batches) {
    if (b.qtyRemaining > 0) {
      const c = categoryOf.get(String(b.product)) || 'No category';
      valueBy.set(c, (valueBy.get(c) || 0) + b.qtyRemaining * cost(b));
    }
    if (b.receivedDate >= months[6].start) receivedBy.set(monthKey(b.receivedDate), (receivedBy.get(monthKey(b.receivedDate)) || 0) + b.qtyReceived * cost(b));
  }
  const warrantyHorizon = new Date(startOfToday.getTime() + 61 * DAY);
  const warranties = installedUnits
    .map((u) => ({ u, end: warrantyEndDate(u.installDate, u.product?.warrantyMonths) }))
    .filter(({ end }) => end && end >= startOfToday && end < warrantyHorizon)
    .sort((a, b) => a.end - b.end)
    .map(({ u, end }) => ({ id: String(u._id), serialNo: u.serialNo, product: u.product?.name || '', client: u.installedProject?.client?.name || '', projectId: u.installedProject?._id ? String(u.installedProject._id) : '', endsOn: end, daysLeft: daysUntilDue(end, now) }));

  const leads = LEAD_SOURCES.map((s, i) => {
    const [unassigned, total, contacted, converted] = leadNumbers.slice(i * 4, i * 4 + 4);
    return { key: s.key, label: s.label, unassigned, total, contacted, converted };
  });
  const sum = (k) => leads.reduce((a, l) => a + l[k], 0);
  const [metaByStatus, googleByStatus, manualByStatus, statuses] = statusGroups;
  const inStatus = new Map();
  const convertedIds = new Set(statuses.filter((st) => st.outcome === 'converted').map((st) => String(st._id)));
  const leadsOf = new Map(); // staff id → their leads (as the lead list's "Assigned to" filter lists them)
  for (const g of [...metaByStatus, ...googleByStatus, ...manualByStatus]) {
    const st = String(g._id.status ?? 'none');
    inStatus.set(st, (inStatus.get(st) || 0) + g.n);
    if (!g._id.to) continue;
    const row = leadsOf.get(String(g._id.to)) || { assigned: 0, notStarted: 0, converted: 0 };
    row.assigned += g.n;
    if (st === 'none') row.notStarted += g.n;
    if (convertedIds.has(st)) row.converted += g.n;
    leadsOf.set(String(g._id.to), row);
  }
  const byStatus = [
    { id: 'none', name: 'Not started', color: 'slate', outcome: 'open', count: inStatus.get('none') || 0 },
    // a deleted status still shows while leads carry it, so every lead is counted somewhere
    ...statuses.filter((st) => !st.isDeleted || inStatus.get(String(st._id))).map((st) => ({ id: String(st._id), name: st.name, color: st.color || 'slate', outcome: st.outcome || 'open', count: inStatus.get(String(st._id)) || 0 })),
  ];
  const annualKwh = won.reduce((a, d) => a + (d.summary?.annualKwh || 0), 0);

  // each staff member's leads and service visits; their installation tasks come from /api/agents/analytics
  const visitsOf = new Map();
  let visitsUnassigned = 0;
  for (const v of amc.items) {
    if (v.status === 'completed' || v.needsInstallation) continue;
    if (!v.assignee) {
      visitsUnassigned += 1;
      continue;
    }
    const row = visitsOf.get(v.assignee.id) || { open: 0, late: 0, today: 0 };
    row.open += 1;
    if (v.booked && v.daysLeft != null && v.daysLeft < 0) row.late += 1;
    if (v.booked && v.daysLeft === 0) row.today += 1;
    visitsOf.set(v.assignee.id, row);
  }
  const people = await User.find({ ...filter, $or: [{ role: ROLES.AGENT }, { _id: { $in: [...leadsOf.keys(), ...visitsOf.keys()] } }] }).select('name active').sort({ name: 1 }).lean();
  const noLeads = { assigned: 0, notStarted: 0, converted: 0 };
  const noVisits = { open: 0, late: 0, today: 0 };

  // month by month, for the charts: money out, leads per source and installations finished
  const spentBy = new Map();
  for (const e of expenses) spentBy.set(monthKey(e.spentOn), (spentBy.get(monthKey(e.spentOn)) || 0) + e.amount);
  const finishedBy = new Map();
  for (const p of finished) finishedBy.set(monthKey(p.installationCompletedAt), (finishedBy.get(monthKey(p.installationCompletedAt)) || 0) + 1);
  const leadsBy = LEAD_SOURCES.map((s, i) => new Map(leadsByMonth[i].map((r) => [r._id, r.n])));
  const since12 = months[0].start;
  const byMode = new Map();
  for (const p of payments) if (p.receivedOn >= since12) byMode.set(p.mode || 'other', (byMode.get(p.mode || 'other') || 0) + p.amount);

  return {
    generatedAt: now,
    amc: {
      dueToday: visits.filter((v) => v.daysLeft === 0).length,
      next30: scheduled.filter((v) => v.daysLeft > 0 && v.daysLeft <= 30).length,
      overdue: visits.filter((v) => v.daysLeft < 0).length,
      visits: visits.slice(0, 6).map((v) => ({ id: v.id, projectId: v.projectId, client: v.client?.name || '', address: v.design?.address || '', visit: v.name, assignee: v.assignee?.name || '', daysLeft: v.daysLeft })),
    },
    money: {
      spentThisMonth: round(spent[0]?.total || 0),
    },
    proposals: { changes, noReply, noInvoice },
    expiring: { count: expiring.length, items: expiring.slice(0, 5), expired: proposed.filter((d) => d.validUntil < startOfToday).length },
    installations: {
      active: active.length,
      byStep: [...atStep.values()].sort((a, b) => a.order - b.order).map(({ step, count }) => ({ step, count })),
      notStarted: notStarted.length,
      unassignedSteps,
      stuck: stuck.sort((a, b) => b.days - a.days).slice(0, 5),
      stuckCount: stuck.length,
      finishedThisMonth: finished.filter((p) => p.installationCompletedAt >= monthStart).length,
      avgDaysToFinish: recentFinished.length ? Math.round(recentFinished.reduce((a, p) => a + daysSince(p.createdAt, p.installationCompletedAt), 0) / recentFinished.length) : null,
    },
    loans: { missing: loanMissing.length, missingItems: loanMissing.slice(0, 5).map((d) => ({ id: String(d._id), name: d.name, type: d.type, client: d.client?.name || '' })), open: loansOpen.length, openAmount: round(loansOpen.reduce((a, l) => a + (l.amount || 0), 0)) },
    subsidies: { missing: subsidyMissing.length, missingItems: subsidyMissing.slice(0, 5).map((d) => ({ id: String(d._id), name: d.name, type: d.type, client: d.client?.name || '' })), open: subsidiesOpen.length, expected: round(subsidiesOpen.reduce((a, s) => a + (s.centralAmount || 0) + (s.stateAmount || 0), 0)) },
    stock: {
      low: lowStock.length,
      items: needsStock.slice(0, 5),
      products: products.length,
      outOfStock: outOfStock.length,
      value: round([...valueBy.values()].reduce((a, v) => a + v, 0)),
      byCategory: [...valueBy].map(([category, value]) => ({ category, value: round(value) })).sort((a, b) => b.value - a.value).slice(0, 8),
      warrantiesEnding: warranties.length,
      warranties: warranties.slice(0, 5),
    },
    support: { open: ticketsOpen, unread: ticketsUnread },
    leads: { unassigned: sum('unassigned'), byStatus, sources: leads, funnel: { leads: sum('total'), contacted: sum('contacted'), converted: sum('converted') } },
    monthly: months.map((m, i) => ({
      key: m.key,
      label: m.label,
      spent: round(spentBy.get(m.key) || 0),
      finished: finishedBy.get(m.key) || 0,
      ...(i >= 6 ? { leads: Object.fromEntries(LEAD_SOURCES.map((s, j) => [s.key, leadsBy[j].get(m.key) || 0])), stockReceived: round(receivedBy.get(m.key) || 0) } : {}),
    })),
    paymentModes: [...byMode].map(([mode, amount]) => ({ mode, amount: round(amount) })).sort((a, b) => b.amount - a.amount),
    staff: {
      members: people.map((u) => ({ id: String(u._id), name: u.name || '', active: u.active !== false, leads: leadsOf.get(String(u._id)) || noLeads, visits: visitsOf.get(String(u._id)) || noVisits })),
      visitsUnassigned,
    },
    impact: { kwp: round(won.reduce((a, d) => a + (d.summary?.kwp || 0), 0)), annualKwh: Math.round(annualKwh), co2Tonnes: round((annualKwh * CO2_KG_PER_KWH) / 1000), installed: finished.length },
  };
}

/** The sale chain's work waiting on someone: e-way bills with no bill yet, and paid bills with no invoice yet. */
const billingActionCount = async (company) => (await EwayBill.countDocuments({ company: company._id, status: 'open' })) + (await Bill.countDocuments({ company: company._id, status: 'paid' }));

/** The numbers shown beside the sidebar links: how many of each thing the company has. `billing` is the count that needs action. */
/** The company's tickets with the platform team that are still open or in progress (as for client support). */
const openPlatformTickets = (company) => Ticket.countDocuments({ company: company._id, status: { $in: ['open', 'in_progress'] } });

export async function counts(company) {
  const filter = { company: company._id };
  const [clients, designs, packages, installations, team, installationCharges, products, categories, billing, metaLeads, googleLeads, manualLeads, amc, clientSupport, loans, subsidies, expenses, suppliers, support] = await Promise.all([
    Client.countDocuments(filter),
    Design.countDocuments(filter),
    Package.countDocuments(filter),
    Project.countDocuments({ ...filter, status: 'active' }),
    User.countDocuments({ ...filter, role: ROLES.AGENT }),
    InstallationCharge.countDocuments(filter),
    Product.countDocuments(filter),
    Category.countDocuments(filter),
    billingActionCount(company),
    // the same leads each lead table lists
    leadModels.meta.countDocuments({ ...filter, isDeleted: false, processingStatus: 'processed' }),
    leadModels.google.countDocuments({ ...filter, isDeleted: false }),
    leadModels.manual.countDocuments({ ...filter, isDeleted: false }),
    amcTrackerCount(company),
    clientTicketOpenCountForCompany(company._id),
    Loan.countDocuments({ ...filter, status: 'in_progress' }),
    Subsidy.countDocuments({ ...filter, status: 'in_progress' }),
    expenseProjectCount(company),
    Supplier.countDocuments(filter),
    openPlatformTickets(company),
  ]);
  return {
    clients,
    loans,
    subsidies,
    expenses,
    suppliers,
    support, // the company's open tickets with the platform team
    designs,
    billing, // e-way bills waiting for a bill, and bills waiting for an invoice
    packages,
    installations,
    amc,
    clientSupport,
    team,
    agentRoles: agentRolesList(company).length,
    installationSteps: company.installationSteps?.length || 0,
    amcTemplates: company.amcTemplates?.length || 0,
    loanSteps: company.loanSteps?.length || 0,
    subsidySteps: company.subsidySteps?.length || 0,
    installationCharges,
    products,
    categories,
    productUnits: company.productUnits?.length || DEFAULT_PRODUCT_UNITS.length,
    leads: metaLeads + googleLeads + manualLeads,
    metaLeads,
    googleLeads,
    manualLeads,
  };
}

/**
 * The staff sidebar's numbers: only the areas this staff member may view, each counted the way their list shows it —
 * leads assigned to them unless they may view all, and their own open tasks and AMC visits. Permissions are the ones
 * resolved for this request, so a role change shows in the next refresh.
 */
export async function staffCounts(user, company) {
  const filter = { company: company._id };
  const may = (area) => hasPermission(user, area, 'view');
  const me = user._id;
  const jobs = {
    // installations with a step of theirs still to do (My tasks), and their unfinished AMC visits
    myTasks: () => Project.countDocuments({ ...filter, steps: { $elemMatch: { assignee: me, status: { $ne: 'done' } } } }),
    amc: async () => (await Project.aggregate([
      { $match: { ...filter, 'amcVisits.assignee': me } },
      { $unwind: '$amcVisits' },
      { $match: { 'amcVisits.assignee': me, 'amcVisits.status': { $ne: 'completed' }, 'amcVisits.workflowStatus': { $ne: 'cancelled' } } },
      { $count: 'n' },
    ]))[0]?.n || 0,
  };
  if (may('leads')) {
    const own = hasPermission(user, 'leads', 'view_all') ? {} : { assignedTo: me }; // as the lead lists scope them
    jobs.metaLeads = () => leadModels.meta.countDocuments({ ...filter, ...own, isDeleted: false, processingStatus: 'processed' });
    jobs.googleLeads = () => leadModels.google.countDocuments({ ...filter, ...own, isDeleted: false });
    jobs.manualLeads = () => leadModels.manual.countDocuments({ ...filter, ...own, isDeleted: false });
  }
  if (may('clients')) jobs.clients = () => Client.countDocuments(filter);
  if (may('proposals')) jobs.designs = () => Design.countDocuments(filter);
  if (may('loans')) jobs.loans = () => Loan.countDocuments({ ...filter, status: 'in_progress' });
  if (may('subsidies')) jobs.subsidies = () => Subsidy.countDocuments({ ...filter, status: 'in_progress' });
  if (may('expenses')) jobs.expenses = () => expenseProjectCount(company);
  if (may('finances')) jobs.billing = () => billingActionCount(company);
  if (may('tasks')) jobs.installations = () => Project.countDocuments({ ...filter, status: 'active' });
  if (may('helpdesk')) jobs.clientSupport = () => clientTicketOpenCountForCompany(company._id);
  if (may('support')) jobs.support = () => openPlatformTickets(company);
  if (may('inventory')) {
    jobs.packages = () => Package.countDocuments(filter);
    jobs.products = () => Product.countDocuments(filter);
    jobs.suppliers = () => Supplier.countDocuments(filter); // the Suppliers page is part of Inventory
  }
  const keys = Object.keys(jobs);
  const values = await Promise.all(keys.map((k) => jobs[k]()));
  const out = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  if (may('leads')) out.leads = out.metaLeads + out.googleLeads + out.manualLeads;
  return out;
}

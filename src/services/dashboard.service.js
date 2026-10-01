// The company dashboard: sales pipeline, money collected and what needs attention — one company-scoped read.
import { DEFAULT_PRODUCT_UNITS, ROLES } from '../constants/index.js';
import { Category, Client, Design, InstallationCharge, Invoice, Package, Payment, Product, Project, User } from '../models/index.js';
import { billingService, totalOf } from './billing.service.js';
import { agentRolesList } from './company.service.js';

const DAY = 24 * 60 * 60 * 1000;
const round = (v) => Math.round((Number(v) || 0) * 100) / 100;
const STATUSES = ['draft', 'proposed', 'won', 'lost'];

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
    Invoice.find({ company: company._id, design: { $ne: null } }).select('design invoiceNo issuedOn total').lean(),
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
  const billed = round(won.reduce((a, w) => a + w.total, 0));
  const collected = round(won.reduce((a, w) => a + w.paid, 0));

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
    money: { billed, collected, outstanding: round(billed - collected), collectedPct: billed ? Math.round((collected / billed) * 100) : 0 },
    revenue,
    thisMonth: revenue.at(-1).amount,
    lastMonth: revenue.at(-2)?.amount || 0,
    activity,
    attention: {
      // client asked for changes on a proposed design
      clientChanges: designs
        .filter((d) => d.status === 'proposed' && d.clientResponse?.decision === 'changes_requested')
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
      followUp: designs.filter((d) => d.status === 'proposed' && !d.clientResponse?.decision && new Date(d.updatedAt) < week).sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt)).slice(0, 5).map((d) => ({ id: String(d._id), name: d.name, type: d.type, client: d.client?.name || '', value: totalOf(d), updatedAt: d.updatedAt })),
      // won proposals with money still to collect
      collect: won.filter((w) => w.balance > 0.001 && w.total > 0).sort((a, b) => b.balance - a.balance).slice(0, 5),
      // booked proposals with a price but no invoice yet
      invoice: won.filter((w) => w.total > 0 && !w.invoiceNo).slice(0, 5),
    },
    recentPayments: payments.slice(0, 6).map((p) => ({ id: String(p._id), receiptNo: p.receiptNo, amount: p.amount, mode: p.mode, receivedOn: p.receivedOn, client: p.client?.name || '', design: p.design?.name || '', designId: String(p.design?._id || '') })),
    recentProposals: [...designs].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 6).map((d) => ({ id: String(d._id), name: d.name, type: d.type, status: d.status, client: d.client?.name || '', kwp: d.summary?.kwp || 0, panels: d.summary?.panels || 0, value: totalOf(d), updatedAt: d.updatedAt })),
  };
}

/** The numbers shown beside the sidebar links: how many of each thing the company has. `billing` is the count that needs action. */
export async function counts(company) {
  const filter = { company: company._id };
  const [clients, designs, packages, installations, team, installationCharges, products, categories, overview] = await Promise.all([
    Client.countDocuments(filter),
    Design.countDocuments(filter),
    Package.countDocuments(filter),
    Project.countDocuments({ ...filter, status: 'active' }),
    User.countDocuments({ ...filter, role: ROLES.AGENT }),
    InstallationCharge.countDocuments(filter),
    Product.countDocuments(filter),
    Category.countDocuments(filter),
    billingService.overview(company),
  ]);
  return {
    clients,
    designs,
    billing: overview.filter((d) => d.total > 0 && d.balance > 0.001).length, // won proposals with money still to collect
    packages,
    installations,
    team,
    agentRoles: agentRolesList(company).length,
    installationSteps: company.installationSteps?.length || 0,
    installationCharges,
    products,
    categories,
    productUnits: company.productUnits?.length || DEFAULT_PRODUCT_UNITS.length,
  };
}

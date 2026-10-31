// One client's whole story on their page (GET /api/clients/:id/overview): their proposals, the installations and
// each one's steps, money billed and received, loans, AMC visits and support requests. Each block is only there when
// the person asking may see that area, so the page shows what they are allowed to.
import { Client, Design, Expense, Invoice, Loan, Payment, Project, Subsidy } from '../models/index.js';
import { hasPermission } from '../middlewares/auth.middleware.js';
import { notFound } from '../utils/HttpError.js';
import { objectId } from '../utils/validators.js';
import { listAmcVisits } from './amc.service.js';
import { totalOf } from './billing.service.js';
import { listClientTickets } from './clientTicket.service.js';

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const DAY = 24 * 60 * 60 * 1000;

export async function clientOverview(company, user, id) {
  const client = await Client.findOne({ _id: objectId(id, 'Client'), company: company._id }).select('name');
  if (!client) throw notFound('Client');
  const may = (area) => hasPermission(user, area, 'view');
  const now = Date.now();

  const designs = await Design.find({ company: company._id, client: client._id }).select('name status type summary.kwp summary.cost summary.pricing.total loanRequired subsidy.enabled createdAt updatedAt').sort({ updatedAt: -1 }).lean();
  const designIds = designs.map((d) => d._id);
  const nameOf = new Map(designs.map((d) => [String(d._id), d.name]));

  const [projects, payments, invoices, loans, subsidies, amc, tickets, expenses] = await Promise.all([
    may('tasks') ? Project.find({ company: company._id, client: client._id }).select('design status steps installationCompletedAt createdAt').populate('steps.assignee', 'name').sort({ updatedAt: -1 }).lean() : null,
    // on the client's proposals, or on the client alone (the proposal-less sale chain)
    may('finances') ? Payment.find({ company: company._id, $or: [{ design: { $in: designIds } }, { client: client._id, design: null }] }).select('design amount mode receivedOn receiptNo').sort({ receivedOn: -1 }).lean() : null,
    may('finances') ? Invoice.find({ company: company._id, status: { $ne: 'void' }, $or: [{ design: { $in: designIds } }, { client: client._id, design: null }] }).select('design invoiceNo total issuedOn pdfName').sort({ issuedOn: -1 }).lean() : null,
    may('loans') ? Loan.find({ company: company._id, client: client._id }).select('design status lender amount steps updatedAt').sort({ updatedAt: -1 }).lean() : null,
    may('subsidies') ? Subsidy.find({ company: company._id, client: client._id }).select('design status scheme centralAmount stateAmount receivedAmount steps updatedAt').sort({ updatedAt: -1 }).lean() : null,
    may('tasks') ? listAmcVisits(company) : null,
    may('helpdesk') ? listClientTickets(user, { client: String(client._id), limit: 50 }).catch(() => ({ items: [] })) : null,
    may('expenses') ? Expense.aggregate([{ $match: { company: company._id, design: { $in: designIds } } }, { $group: { _id: '$design', total: { $sum: '$amount' }, count: { $sum: 1 }, last: { $max: '$spentOn' } } }]) : null,
  ]);

  const proposals = designs.map((d) => ({
    id: String(d._id),
    name: d.name,
    status: d.status,
    type: d.type,
    kwp: d.summary?.kwp || 0,
    value: totalOf(d),
    loanRequired: Boolean(d.loanRequired),
    subsidy: Boolean(d.subsidy?.enabled),
    createdAt: d.createdAt,
  }));

  const installations = projects?.map((p) => {
    const steps = (p.steps || []).map((s, i) => ({
      id: String(s._id),
      name: s.name,
      index: i + 1,
      status: s.status,
      priority: s.priority || 'medium',
      assignee: s.assignee ? { id: String(s.assignee._id), name: s.assignee.name || '' } : null,
      startedAt: s.startedAt || null,
      completedAt: s.completedAt || null,
      stuck: s.status === 'in_progress' && Boolean(s.startedAt) && now - new Date(s.startedAt).getTime() > 7 * DAY,
    }));
    const current = steps.find((s) => s.status !== 'done') || null;
    return {
      id: String(p._id),
      design: { id: String(p.design), name: nameOf.get(String(p.design)) || 'Installation' },
      status: p.status,
      startedAt: p.createdAt,
      installationCompletedAt: p.installationCompletedAt || null,
      done: steps.filter((s) => s.status === 'done').length,
      total: steps.length,
      current,
      steps,
    };
  }) ?? null;

  let billing = null;
  if (payments && invoices) {
    const rows = designs.filter((d) => d.status === 'won').map((d) => {
      const paid = money(payments.filter((p) => String(p.design) === String(d._id)).reduce((a, p) => a + p.amount, 0));
      const total = totalOf(d);
      return { id: String(d._id), name: d.name, total, paid, balance: money(total - paid), lastPaidOn: payments.find((p) => String(p.design) === String(d._id))?.receivedOn || null };
    });
    billing = {
      total: money(rows.reduce((a, r) => a + r.total, 0)),
      paid: money(rows.reduce((a, r) => a + r.paid, 0)),
      balance: money(rows.reduce((a, r) => a + r.balance, 0)),
      rows,
      payments: payments.map((p) => ({ id: String(p._id), design: p.design ? { id: String(p.design), name: nameOf.get(String(p.design)) || '' } : null, amount: p.amount, mode: p.mode, receivedOn: p.receivedOn, receiptNo: p.receiptNo })),
      invoices: invoices.map((i) => ({ id: String(i._id), design: i.design ? { id: String(i.design), name: nameOf.get(String(i.design)) || '' } : null, invoiceNo: i.invoiceNo, total: i.total, issuedOn: i.issuedOn, hasPdf: Boolean(i.pdfName) })),
    };
  }

  const loanRows = loans?.map((l) => {
    const steps = l.steps || [];
    const current = steps.find((s) => s.status !== 'done') || null;
    return { id: String(l._id), design: { id: String(l.design), name: nameOf.get(String(l.design)) || '' }, status: l.status, lender: l.lender || '', amount: l.amount ?? null, done: steps.filter((s) => s.status === 'done').length, total: steps.length, currentStep: current?.name || '', updatedAt: l.updatedAt };
  }) ?? null;

  const subsidyRows = subsidies?.map((l) => {
    const steps = l.steps || [];
    const current = steps.find((s) => s.status !== 'done') || null;
    return { id: String(l._id), design: { id: String(l.design), name: nameOf.get(String(l.design)) || '' }, status: l.status, scheme: l.scheme || '', expected: (l.centralAmount || 0) + (l.stateAmount || 0), received: l.receivedAmount ?? null, done: steps.filter((s) => s.status === 'done').length, total: steps.length, currentStep: current?.name || '', updatedAt: l.updatedAt };
  }) ?? null;

  const visits = amc
    ? amc.items.filter((v) => v.client?.id === String(client._id)).map((v) => ({ id: v.id, projectId: v.projectId, name: v.name, kind: v.kind, free: v.free, dueDate: v.dueDate, daysLeft: v.daysLeft, booked: v.booked, status: v.status, assignee: v.assignee, completedAt: v.completedAt, design: v.design ? { id: v.design.id, name: v.design.name } : null }))
      .sort((a, b) => (a.status === 'completed') - (b.status === 'completed') || (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999))
    : null;

  return {
    client: { id: String(client._id), name: client.name },
    proposals,
    installations,
    billing,
    loans: loanRows,
    subsidies: subsidyRows,
    amc: visits,
    tickets: tickets ? tickets.items.map((t) => ({ id: t.id, ref: t.ref, subject: t.subject, status: t.status, updatedAt: t.updatedAt, messageCount: t.messageCount, teamUnread: t.teamUnread })) : null,
    expenses: expenses ? { total: money(expenses.reduce((a, e) => a + e.total, 0)), rows: expenses.map((e) => ({ design: { id: String(e._id), name: nameOf.get(String(e._id)) || '' }, total: money(e.total), count: e.count, last: e.last })) } : null,
  };
}

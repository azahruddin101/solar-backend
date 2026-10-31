// One staff member's page (GET /api/agents/:id/overview): who they are, and everything on their plate — installation
// steps, leads, AMC visits, expenses they recorded and what they did lately. Counted as the lists they link to count.
import mongoose from 'mongoose';
import { STEP_PRIORITIES } from '../constants/index.js';
import { Design, Expense, Project } from '../models/index.js';
import { leadAssignmentModel, leadModels } from '../integrations/leads.js';
import { notFound } from '../utils/HttpError.js';
import { objectId } from '../utils/validators.js';
import { listAgents } from './agent.service.js';
import { listAmcVisits } from './amc.service.js';

const DAY = 24 * 60 * 60 * 1000;
const round = (v) => Math.round((Number(v) || 0) * 100) / 100;
const monthKey = (d) => `${new Date(d).getFullYear()}-${String(new Date(d).getMonth() + 1).padStart(2, '0')}`;
const PRIORITY_RANK = Object.fromEntries(STEP_PRIORITIES.map((p, i) => [p, -i])); // urgent first

function lastMonths(n, now) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (n - 1 - i), 1);
    return { key: monthKey(d), label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) };
  });
}

/** The lead statuses this person's leads sit in, and their latest leads — as the lead list shows them. */
async function leadsOf(company, userId) {
  const filter = { company: company._id, assignedTo: userId, isDeleted: false };
  const statusLookup = [
    { $lookup: { from: leadAssignmentModel.collection.name, let: { lead: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$lead', '$$lead'] }, isActive: true } }, { $project: { currentStatus: 1 } }], as: 'assignment' } },
    { $addFields: { current: { $ifNull: [{ $arrayElemAt: ['$assignment.currentStatus', 0] }, '$adminStatus'] } } },
  ];
  const metaMatch = { $match: { ...filter, processingStatus: 'processed' } };
  const [metaGroups, googleGroups, manualGroups, statuses, metaRecent, googleRecent, manualRecent] = await Promise.all([
    leadModels.meta.aggregate([metaMatch, ...statusLookup, { $group: { _id: '$current', n: { $sum: 1 } } }]),
    leadModels.google.aggregate([{ $match: filter }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    leadModels.manual.aggregate([{ $match: filter }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    leadModels.status.find({ company: company._id }).select('name color order outcome isDeleted').sort({ order: 1, createdAt: 1 }).lean(),
    leadModels.meta.aggregate([metaMatch, { $sort: { leadCreatedAt: -1, _id: -1 } }, { $limit: 50 }, ...statusLookup, { $project: { fullName: 1, phone: 1, at: { $ifNull: ['$leadCreatedAt', '$createdAt'] }, current: 1 } }]),
    leadModels.google.find(filter).sort({ createdAt: -1 }).limit(50).select('fullName phone createdAt status').lean(),
    leadModels.manual.find(filter).sort({ createdAt: -1 }).limit(50).select('fullName phone createdAt status source').lean(),
  ]);
  const count = new Map();
  for (const g of [...metaGroups, ...googleGroups, ...manualGroups]) count.set(String(g._id ?? 'none'), (count.get(String(g._id ?? 'none')) || 0) + g.n);
  const statusById = new Map(statuses.map((s) => [String(s._id), s]));
  const byStatus = [
    { id: 'none', name: 'Not started', color: 'slate', outcome: 'open', count: count.get('none') || 0 },
    ...statuses.filter((s) => !s.isDeleted || count.get(String(s._id))).map((s) => ({ id: String(s._id), name: s.name, color: s.color || 'slate', outcome: s.outcome || 'open', count: count.get(String(s._id)) || 0 })),
  ];
  const statusOf = (id) => (id && statusById.get(String(id)) ? { name: statusById.get(String(id)).name, color: statusById.get(String(id)).color || 'slate' } : null);
  const recent = [
    ...metaRecent.map((l) => ({ id: String(l._id), name: l.fullName || '', phone: l.phone || '', source: 'Facebook / Instagram', at: l.at, status: statusOf(l.current) })),
    ...googleRecent.map((l) => ({ id: String(l._id), name: l.fullName || '', phone: l.phone || '', source: 'Google Ads', at: l.createdAt, status: statusOf(l.status) })),
    ...manualRecent.map((l) => ({ id: String(l._id), name: l.fullName || '', phone: l.phone || '', source: l.source === 'import' ? 'Imported' : 'Added by your team', at: l.createdAt, status: statusOf(l.status) })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 50); // the latest 50, paged on the page
  const converted = new Set(statuses.filter((s) => s.outcome === 'converted').map((s) => String(s._id)));
  const total = byStatus.reduce((a, s) => a + s.count, 0);

  // leads this person held and then handed over: still theirs to answer for, so they stay on the profile
  const past = { company: company._id, 'assignmentHistory.assignee': userId, assignedTo: { $ne: userId }, isDeleted: false };
  const pastSelect = 'fullName phone createdAt leadCreatedAt assignedTo assignmentHistory';
  const [pastMeta, pastGoogle, pastManual] = await Promise.all([
    leadModels.meta.find({ ...past, processingStatus: 'processed' }).select(pastSelect).populate('assignedTo', 'name').sort({ leadCreatedAt: -1 }).limit(50).lean(),
    leadModels.google.find(past).select(pastSelect).populate('assignedTo', 'name').sort({ createdAt: -1 }).limit(50).lean(),
    leadModels.manual.find(past).select(`${pastSelect} source`).populate('assignedTo', 'name').sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  const handedOverRow = (l, source) => {
    const mine = [...(l.assignmentHistory || [])].reverse().find((h) => String(h.assignee) === String(userId));
    return { id: String(l._id), name: l.fullName || '', phone: l.phone || '', source, at: l.leadCreatedAt || l.createdAt, status: null, handedOver: true, nowWith: l.assignedTo?.name || '', heldFrom: mine?.assignedAt || null, heldUntil: mine?.endedAt || null };
  };
  const handedOver = [
    ...pastMeta.map((l) => handedOverRow(l, 'Facebook / Instagram')),
    ...pastGoogle.map((l) => handedOverRow(l, 'Google Ads')),
    ...pastManual.map((l) => handedOverRow(l, l.source === 'import' ? 'Imported' : 'Added by your team')),
  ].sort((a, b) => new Date(b.heldUntil || 0) - new Date(a.heldUntil || 0));
  // the log of every lead they hold or have held: assignments, hand-overs, status changes, reschedules
  const held = { company: company._id, isDeleted: false, $or: [{ assignedTo: userId }, { 'assignmentHistory.assignee': userId }], 'logs.0': { $exists: true } };
  const logSelect = 'fullName phone logs';
  const [logMeta, logGoogle, logManual] = await Promise.all([
    leadModels.meta.find({ ...held, processingStatus: 'processed' }).select(logSelect).sort({ updatedAt: -1 }).limit(100).lean(),
    leadModels.google.find(held).select(logSelect).sort({ updatedAt: -1 }).limit(100).lean(),
    leadModels.manual.find(held).select(logSelect).sort({ updatedAt: -1 }).limit(100).lean(),
  ]);
  const leadLog = [...logMeta, ...logGoogle, ...logManual]
    .flatMap((l) => (l.logs || []).map((e) => ({ phase: 'lead', at: e.at, action: e.action, byName: e.byName || '', message: e.message || '', where: l.fullName || l.phone || 'Lead', leadId: String(l._id) })))
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 50);

  const handedOverCount = (await Promise.all([leadModels.meta.countDocuments({ ...past, processingStatus: 'processed' }), leadModels.google.countDocuments(past), leadModels.manual.countDocuments(past)])).reduce((a, n) => a + n, 0);

  return { total, notStarted: count.get('none') || 0, converted: [...count].reduce((a, [k, n]) => a + (converted.has(k) ? n : 0), 0), byStatus, recent, handedOver, handedOverCount, log: leadLog };
}

export async function staffOverview(company, id) {
  const userId = new mongoose.Types.ObjectId(objectId(id, 'Staff member')); // an ObjectId: aggregations don't cast strings
  const profile = (await listAgents(company)).find((a) => a.id === String(userId));
  if (!profile) throw notFound('Staff member');
  const now = new Date();
  const months = lastMonths(6, now);
  const since90 = new Date(now.getTime() - 90 * DAY);

  const projects = await Project.find({ company: company._id, 'steps.assignee': userId }).select('design client status steps').populate('design', 'name summary.address').populate('client', 'name phone').lean();
  const myStepIds = projects.flatMap((p) => (p.steps || []).filter((s) => String(s.assignee) === String(userId)).map((s) => s._id));
  // installation log lines they wrote, or about their own steps (e.g. the owner marking their step done)
  const mine = { $or: [{ 'logs.by': userId }, { 'logs.step': { $in: myStepIds } }] };

  const [amc, leads, expenses, projectLogs, designLogs] = await Promise.all([
    listAmcVisits(company, { agentId: userId }),
    leadsOf(company, userId),
    Expense.find({ company: company._id, createdBy: userId, spentOn: { $gte: since90 } }).sort({ spentOn: -1 }).populate('design', 'name').lean(),
    Project.aggregate([
      { $match: { company: company._id, ...mine } },
      { $unwind: '$logs' },
      { $match: mine },
      { $sort: { 'logs.at': -1 } },
      { $limit: 50 },
      { $lookup: { from: 'designs', localField: 'design', foreignField: '_id', as: 'd', pipeline: [{ $project: { name: 1 } }] } },
      { $project: { log: '$logs', name: { $arrayElemAt: ['$d.name', 0] } } },
    ]),
    Design.aggregate([
      { $match: { company: company._id, 'logs.by': userId } },
      { $unwind: '$logs' },
      { $match: { 'logs.by': userId } },
      { $sort: { 'logs.at': -1 } },
      { $limit: 50 },
      { $project: { log: '$logs', name: 1, type: 1, panels: '$summary.panels' } },
    ]),
  ]);

  // their installation steps, with the job each one belongs to
  const steps = projects.flatMap((p) => (p.steps || []).filter((s) => String(s.assignee) === String(userId)).map((s) => ({
    projectId: String(p._id),
    project: p.design?.name || '',
    client: p.client?.name || '',
    address: p.design?.summary?.address || '',
    projectStatus: p.status,
    step: s.name,
    role: s.role || '',
    priority: s.priority || 'medium',
    status: s.status,
    startedAt: s.startedAt || null,
    completedAt: s.completedAt || null,
    stuck: s.status === 'in_progress' && Boolean(s.startedAt) && now - new Date(s.startedAt) > 7 * DAY, // as the dashboard's "stuck" counts
  })));
  const open = steps.filter((s) => s.status !== 'done').sort((a, b) => (PRIORITY_RANK[a.priority] ?? 0) - (PRIORITY_RANK[b.priority] ?? 0) || (a.status === 'in_progress' ? -1 : 1));
  const done = steps.filter((s) => s.status === 'done' && s.completedAt).sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  const timed = done.filter((s) => s.startedAt && new Date(s.completedAt) >= since90);
  const doneBy = new Map();
  for (const s of done) doneBy.set(monthKey(s.completedAt), (doneBy.get(monthKey(s.completedAt)) || 0) + 1);

  // their AMC visits (as the AMC board lists them when filtered to this person)
  const visits = amc.items.filter((v) => v.assignee && v.assignee.id === String(userId));
  const openVisits = visits.filter((v) => v.status !== 'completed').sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
  const doneVisits = visits.filter((v) => v.status === 'completed');

  const activity = [
    ...projectLogs.map((r) => ({ phase: 'installation', byName: String(r.log.by) === String(userId) ? '' : r.log.byName || '', at: r.log.at, action: r.log.action, stepName: r.log.stepName || '', message: r.log.message || '', where: r.name || 'Installation', href: `/dashboard/installations/${r._id}` })),
    ...designLogs.map((r) => ({ phase: 'design', byName: '', at: r.log.at, action: r.log.action, stepName: r.log.stepName || '', message: r.log.message || '', where: r.name || 'Proposal', design: { id: String(r._id), type: r.type, summary: { panels: r.panels || 0 } } })),
    ...leads.log.map((e) => ({ ...e, href: `/dashboard/leads?search=${encodeURIComponent(e.where)}` })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 50);

  return {
    profile: {
      id: profile.id,
      name: profile.name || '',
      email: profile.email || '',
      phone: profile.phone || '',
      photo: profile.photo || '',
      roles: profile.roles || [],
      staffRoles: profile.staffRoles || [],
      active: profile.active !== false,
      createdAt: profile.createdAt || null,
      lastLoginAt: profile.lastLoginAt || null,
    },
    tasks: {
      open: open.length,
      inProgress: open.filter((s) => s.status === 'in_progress').length,
      pending: open.filter((s) => s.status === 'pending').length,
      stuck: open.filter((s) => s.stuck).length,
      done7: done.filter((s) => now - new Date(s.completedAt) <= 7 * DAY).length,
      done30: done.filter((s) => now - new Date(s.completedAt) <= 30 * DAY).length,
      doneTotal: done.length,
      avgHours: timed.length ? Math.round((timed.reduce((a, s) => a + (new Date(s.completedAt) - new Date(s.startedAt)), 0) / timed.length / 3600000) * 10) / 10 : null,
      jobs: new Set(open.map((s) => s.projectId)).size,
      monthly: months.map((m) => ({ ...m, done: doneBy.get(m.key) || 0 })),
      openList: open, // all of them: the page shows them a few at a time
      doneList: done.slice(0, 50),
    },
    leads,
    visits: {
      open: openVisits.length,
      late: openVisits.filter((v) => v.booked && v.daysLeft != null && v.daysLeft < 0).length,
      today: openVisits.filter((v) => v.booked && v.daysLeft === 0).length,
      done: doneVisits.length,
      openList: openVisits.map((v) => ({ id: v.id, projectId: v.projectId, name: v.name, client: v.client?.name || '', address: v.design?.address || '', daysLeft: v.daysLeft, dueDate: v.dueDate, booked: v.booked })),
    },
    expenses: {
      count: expenses.length,
      total: round(expenses.reduce((a, e) => a + e.amount, 0)),
      recent: expenses.map((e) => ({ id: String(e._id), amount: e.amount, reason: e.reason, spentOn: e.spentOn, design: e.design ? { id: String(e.design._id), name: e.design.name } : null })),
    },
    activity,
  };
}

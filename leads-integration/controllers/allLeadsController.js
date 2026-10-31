// Combined lead list across Meta, Google Ads and manual leads (same filters where they apply).
const mongoose = require('mongoose');
const MetaLead = require('../models/MetaLead');
const GoogleLead = require('../models/GoogleLead');
const ManualLead = require('../models/ManualLead');
const MetaLeadAssignment = require('../models/MetaLeadAssignment');
const MetaLeadStatus = require('../models/MetaLeadStatus');
const { leadCompanyFilter } = require('../utils/tenant');
const { assignedScope } = require('../utils/leadScope');
const { applyLeadSearch } = require('../utils/leadSearch');
const { readPriorityFilter, priorityCondition } = require('../utils/leadPriority');
const { scheduleCondition } = require('../utils/leadSchedule');
const { heldByCondition } = require('../utils/leadAssignment');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const isObjectId = (value) => typeof value === 'string' && mongoose.isValidObjectId(value);

const SOURCE_LABEL = { meta: 'Meta', google: 'Google Ads', manual: 'Added', import: 'Imported' };

const toRow = (lead, leadSource, extra = {}) => ({
  _id: lead._id,
  leadSource,
  sourceLabel: SOURCE_LABEL[leadSource] || leadSource,
  fullName: lead.fullName || '',
  phone: lead.phone || '',
  address: lead.address || '',
  receivedAt: lead.leadCreatedAt || lead.createdAt,
  createdAt: lead.createdAt,
  assignedTo: lead.assignedTo?._id
    ? { _id: lead.assignedTo._id, name: lead.assignedTo.name || '' }
    : lead.assignedTo?.name
      ? { _id: lead.assignedTo, name: lead.assignedTo.name }
      : null,
  assignedAt: lead.assignedAt || null,
  isPriority: Boolean(lead.isPriority),
  scheduledAt: lead.scheduledAt || null,
  rescheduledCount: lead.rescheduledCount || 0,
  isRescheduled: Boolean(lead.isRescheduled),
  isReassigned: Boolean(lead.isReassigned),
  reassignedCount: lead.reassignedCount || 0,
  assignmentHistory: (lead.assignmentHistory || []).map((h) => ({ id: h.assignee ? String(h.assignee) : null, name: h.assigneeName || '', assignedAt: h.assignedAt, endedAt: h.endedAt || null })),
  heldBefore: Boolean(lead.heldBefore),
  previousSchedules: (lead.previousSchedules || []).map((p) => ({ scheduledAt: p.scheduledAt, statusName: p.statusName || '', replacedAt: p.replacedAt, byName: p.byName || '' })),
  currentStatus: lead.currentStatus || null,
  convertedClient: lead.convertedClient || null,
  convertedClientName: lead.convertedClientName || '',
  convertedAt: lead.convertedAt || null,
  ...extra,
});

/** Which sources to include from ?source= (meta | google | manual | import). */
function sourcesWanted(raw) {
  const v = text(raw).toLowerCase();
  if (v === 'meta') return { meta: true, google: false, manual: false };
  if (v === 'google') return { meta: false, google: true, manual: false };
  if (v === 'manual' || v === 'import') return { meta: false, google: false, manual: true, manualSource: v };
  if (v === 'manual_all') return { meta: false, google: false, manual: true, manualSource: null }; // added and imported together (the Manual leads board)
  return { meta: true, google: true, manual: true, manualSource: null };
}

async function applyMetaStatusFilter(filter, req, statusId, tenant) {
  if (!statusId) return;
  if (statusId === 'none') {
    // no status from the telecaller nor the admin — including leads never assigned (they show as "Not started" too)
    const ownerHasStatus = await MetaLeadAssignment.distinct('lead', { ...tenant, isActive: true, currentStatus: { $ne: null } });
    filter.adminStatus = null;
    filter._id = { $nin: ownerHasStatus };
    return;
  }
  if (!isObjectId(statusId)) return;
  const owned = await MetaLeadAssignment.distinct('lead', { ...tenant, isActive: true, currentStatus: statusId });
  const ownerHasStatus = await MetaLeadAssignment.distinct('lead', { ...tenant, isActive: true, currentStatus: { $ne: null } });
  const adminOnly = await MetaLead.distinct('_id', {
    ...tenant,
    adminStatus: statusId,
    _id: { $nin: ownerHasStatus },
  });
  filter._id = { $in: [...owned, ...adminOnly] };
}

async function loadMetaChunk(req, limit, statusId) {
  const tenant = leadCompanyFilter(req.leadsCompanyId);
  const filter = { ...tenant, processingStatus: 'processed', isDeleted: false };
  const search = text(req.query.search).slice(0, 100).toLowerCase();
  await applyLeadSearch(filter, { companyId: req.leadsCompanyId, search, kind: 'meta' });
  const assignedTo = text(req.query.assignedTo);
  if (assignedTo === 'unassigned') filter.assignedTo = null; // never assigned, or assignment cleared (as the dashboard counts them)
  else if (assignedTo === 'reassigned') filter.isReassigned = true;
  else if (isObjectId(assignedTo)) Object.assign(filter, heldByCondition(assignedTo, { includePast: text(req.query.includePast) === '1' }));
  const { priority, invalid } = readPriorityFilter(req.query.priority);
  if (invalid) throw Object.assign(new Error('Invalid filter'), { status: 400 });
  if (priority !== null) filter.isPriority = priorityCondition(priority);
  Object.assign(filter, scheduleCondition(req.query.schedule) || {});
  const pageId = text(req.query.pageId);
  const formId = text(req.query.formId);
  if (pageId) filter.pageId = pageId;
  if (formId) filter.formId = formId;
  const from = text(req.query.from || req.query.fromDate);
  const to = text(req.query.to || req.query.toDate);
  if (from && !Number.isNaN(Date.parse(from))) filter.leadCreatedAt = { ...(filter.leadCreatedAt || {}), $gte: new Date(from) };
  if (to && !Number.isNaN(Date.parse(to))) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    filter.leadCreatedAt = { ...(filter.leadCreatedAt || {}), $lte: end };
  }
  Object.assign(filter, assignedScope(req));
  if (statusId) await applyMetaStatusFilter(filter, req, statusId, tenant);

  const [total, leads] = await Promise.all([
    MetaLead.countDocuments(filter),
    MetaLead.find(filter)
      .sort({ leadCreatedAt: -1, _id: -1 })
      .limit(limit)
      .select('fullName phone fields leadCreatedAt createdAt assignedTo isPriority scheduledAt rescheduledCount isRescheduled isReassigned reassignedCount assignmentHistory convertedClient convertedClientName convertedAt adminStatus')
      .populate('assignedTo', 'name')
      .populate('adminStatus', 'name color')
      .lean(),
  ]);
  const assignments = await MetaLeadAssignment.find({ ...tenant, lead: { $in: leads.map((l) => l._id) }, isActive: true })
    .select('lead currentStatus')
    .populate('currentStatus', 'name color')
    .lean();
  const statusByLead = new Map(assignments.map((a) => [String(a.lead), a.currentStatus]));
  const items = leads.map((lead) => {
    const currentStatus = statusByLead.get(String(lead._id)) || lead.adminStatus || null;
    const st = currentStatus
      ? { _id: currentStatus._id, name: currentStatus.name, color: currentStatus.color }
      : null;
    return toRow({ ...lead, currentStatus: st }, 'meta');
  });
  return { total, items };
}

async function loadGoogleChunk(req, limit, statusId) {
  const filter = { ...leadCompanyFilter(req.leadsCompanyId), isDeleted: false };
  const search = text(req.query.search).slice(0, 100).toLowerCase();
  await applyLeadSearch(filter, { companyId: req.leadsCompanyId, search, kind: 'google' });
  const assignedTo = text(req.query.assignedTo);
  if (assignedTo === 'unassigned') filter.assignedTo = null;
  else if (assignedTo === 'reassigned') filter.isReassigned = true;
  else if (isObjectId(assignedTo)) Object.assign(filter, heldByCondition(assignedTo, { includePast: text(req.query.includePast) === '1' }));
  if (statusId === 'none') filter.status = null;
  else if (isObjectId(statusId)) filter.status = statusId;
  const { priority, invalid } = readPriorityFilter(req.query.priority);
  if (invalid) throw Object.assign(new Error('Invalid filter'), { status: 400 });
  if (priority !== null) filter.isPriority = priorityCondition(priority);
  Object.assign(filter, scheduleCondition(req.query.schedule) || {});
  const from = text(req.query.from || req.query.fromDate);
  const to = text(req.query.to || req.query.toDate);
  if (from && !Number.isNaN(Date.parse(from))) filter.createdAt = { ...(filter.createdAt || {}), $gte: new Date(from) };
  if (to && !Number.isNaN(Date.parse(to))) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    filter.createdAt = { ...(filter.createdAt || {}), $lte: end };
  }
  Object.assign(filter, assignedScope(req));

  const [total, leads] = await Promise.all([
    GoogleLead.countDocuments(filter),
    GoogleLead.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .select('fullName phone fields createdAt assignedTo assignedAt isPriority scheduledAt rescheduledCount isRescheduled isReassigned reassignedCount assignmentHistory convertedClient convertedClientName convertedAt statusName statusColor status')
      .populate('assignedTo', 'name')
      .populate('status', 'name color')
      .lean(),
  ]);
  const items = leads.map((lead) => toRow({
    ...lead,
    currentStatus: lead.status
      ? { _id: lead.status._id, name: lead.statusName || lead.status.name, color: lead.statusColor || lead.status.color }
      : null,
  }, 'google'));
  return { total, items };
}

async function loadManualChunk(req, limit, statusId, manualSource) {
  const filter = { ...leadCompanyFilter(req.leadsCompanyId), isDeleted: false };
  const search = text(req.query.search).slice(0, 100).toLowerCase();
  await applyLeadSearch(filter, { companyId: req.leadsCompanyId, search, kind: 'manual' });
  const assignedTo = text(req.query.assignedTo);
  if (assignedTo === 'unassigned') filter.assignedTo = null;
  else if (assignedTo === 'reassigned') filter.isReassigned = true;
  else if (isObjectId(assignedTo)) Object.assign(filter, heldByCondition(assignedTo, { includePast: text(req.query.includePast) === '1' }));
  if (statusId === 'none') filter.status = null;
  else if (isObjectId(statusId)) filter.status = statusId;
  if (manualSource === 'manual' || manualSource === 'import') filter.source = manualSource;
  const { priority, invalid } = readPriorityFilter(req.query.priority);
  if (invalid) throw Object.assign(new Error('Invalid filter'), { status: 400 });
  if (priority !== null) filter.isPriority = priorityCondition(priority);
  Object.assign(filter, scheduleCondition(req.query.schedule) || {});
  const from = text(req.query.from || req.query.fromDate);
  const to = text(req.query.to || req.query.toDate);
  if (from && !Number.isNaN(Date.parse(from))) filter.createdAt = { ...(filter.createdAt || {}), $gte: new Date(from) };
  if (to && !Number.isNaN(Date.parse(to))) filter.createdAt = { ...(filter.createdAt || {}), $lte: new Date(to) };
  Object.assign(filter, assignedScope(req));

  const [total, leads] = await Promise.all([
    ManualLead.countDocuments(filter),
    ManualLead.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .select('fullName phone address source createdAt assignedTo assignedAt isPriority scheduledAt rescheduledCount isRescheduled isReassigned reassignedCount assignmentHistory convertedClient convertedClientName convertedAt statusName statusColor status')
      .populate('assignedTo', 'name')
      .lean(),
  ]);
  const items = leads.map((lead) => toRow({
    ...lead,
    currentStatus: lead.status
      ? { _id: lead.status._id || lead.status, name: lead.statusName, color: lead.statusColor }
      : null,
  }, lead.source === 'import' ? 'import' : 'manual', { address: lead.address || '' }));
  return { total, items };
}

// @route GET /api/leads/all
const listAllLeads = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const statusId = text(req.query.statusId);
    const wanted = sourcesWanted(req.query.source);
    const fetchCap = page * pageSize;

    const parts = await Promise.all([
      wanted.meta ? loadMetaChunk(req, fetchCap, statusId) : { total: 0, items: [] },
      wanted.google ? loadGoogleChunk(req, fetchCap, statusId) : { total: 0, items: [] },
      wanted.manual ? loadManualChunk(req, fetchCap, statusId, wanted.manualSource) : { total: 0, items: [] },
    ]);

    const total = parts.reduce((n, p) => n + p.total, 0);
    const merged = parts
      .flatMap((p) => p.items)
      .sort((a, b) => (scheduleCondition(req.query.schedule) ? new Date(a.scheduledAt) - new Date(b.scheduledAt) : 0) || new Date(b.receivedAt) - new Date(a.receivedAt) || String(b._id).localeCompare(String(a._id))); // a schedule filter: soonest first
    const leads = merged.slice((page - 1) * pageSize, page * pageSize);

    res.json({
      leads,
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ message: error.message });
    console.error('[ALL_LEADS]', error.message);
    res.status(500).json({ message: 'Could not load leads' });
  }
};

// The Kanban board: every lead (all sources, same filters as the list) in a column per status, "Not started" first.
// Each source is capped so the board stays usable; `truncated` tells the page when a source had more.
const BOARD_CAP = 400;
const listLeadBoard = async (req, res) => {
  try {
    const wanted = sourcesWanted(req.query.source);
    const [meta, google, manual, statuses] = await Promise.all([
      wanted.meta ? loadMetaChunk(req, BOARD_CAP, '') : { total: 0, items: [] },
      wanted.google ? loadGoogleChunk(req, BOARD_CAP, '') : { total: 0, items: [] },
      wanted.manual ? loadManualChunk(req, BOARD_CAP, '', wanted.manualSource) : { total: 0, items: [] },
      MetaLeadStatus.find({ ...leadCompanyFilter(req.leadsCompanyId), isDeleted: false }).sort({ order: 1, createdAt: 1 }).lean(),
    ]);
    const byStatus = new Map();
    for (const lead of [meta, google, manual].flatMap((p) => p.items)) {
      const key = lead.currentStatus ? String(lead.currentStatus._id) : 'none';
      if (!byStatus.has(key)) byStatus.set(key, []);
      byStatus.get(key).push(lead);
    }
    const newestFirst = (a, b) => new Date(b.receivedAt) - new Date(a.receivedAt) || String(b._id).localeCompare(String(a._id));
    const column = (id, st, leads) => ({
      id,
      name: st.name,
      color: st.color || 'slate',
      outcome: st.outcome || 'open',
      requiresDate: Boolean(st.requiresDate),
      isActive: st.isActive !== false,
      count: leads.length,
      leads: leads.sort(newestFirst),
    });
    const columns = [
      column('none', { name: 'Not started', color: 'slate', outcome: 'open' }, byStatus.get('none') || []),
      // switched-off statuses stay only while a lead still sits in them
      ...statuses.filter((st) => st.isActive !== false || byStatus.has(String(st._id))).map((st) => column(String(st._id), st, byStatus.get(String(st._id)) || [])),
    ];
    const parts = [meta, google, manual];
    res.json({
      columns,
      total: parts.reduce((n, p) => n + p.total, 0),
      truncated: parts.some((p) => p.total > BOARD_CAP),
    });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ message: error.message });
    console.error('Error loading the lead board:', error);
    res.status(500).json({ message: 'Could not load the board' });
  }
};

module.exports = { listAllLeads, listLeadBoard };

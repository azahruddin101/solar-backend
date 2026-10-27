// Combined lead list across Meta, Google Ads and manual leads (same filters where they apply).
const mongoose = require('mongoose');
const MetaLead = require('../models/MetaLead');
const GoogleLead = require('../models/GoogleLead');
const ManualLead = require('../models/ManualLead');
const MetaLeadAssignment = require('../models/MetaLeadAssignment');
const { leadCompanyFilter } = require('../utils/tenant');
const { assignedScope } = require('../utils/leadScope');
const { applyLeadSearch } = require('../utils/leadSearch');
const { readPriorityFilter, priorityCondition } = require('../utils/leadPriority');

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
  currentStatus: lead.currentStatus || null,
  convertedClient: lead.convertedClient || null,
  convertedClientName: lead.convertedClientName || '',
  ...extra,
});

/** Which sources to include from ?source= (meta | google | manual | import). */
function sourcesWanted(raw) {
  const v = text(raw).toLowerCase();
  if (v === 'meta') return { meta: true, google: false, manual: false };
  if (v === 'google') return { meta: false, google: true, manual: false };
  if (v === 'manual' || v === 'import') return { meta: false, google: false, manual: true, manualSource: v };
  return { meta: true, google: true, manual: true, manualSource: null };
}

async function applyMetaStatusFilter(filter, req, statusId, tenant) {
  if (!statusId) return;
  if (statusId === 'none') {
    const notStarted = await MetaLeadAssignment.distinct('lead', { ...tenant, isActive: true, currentStatus: null });
    const coveredByAdmin = await MetaLead.distinct('_id', {
      ...tenant,
      _id: { $in: notStarted },
      adminStatus: { $ne: null },
    });
    const covered = new Set(coveredByAdmin.map(String));
    filter._id = { $in: notStarted.filter((id) => !covered.has(String(id))) };
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
  if (assignedTo === 'unassigned') filter.assignedTo = { $exists: false };
  else if (isObjectId(assignedTo)) filter.assignedTo = assignedTo;
  const { priority, invalid } = readPriorityFilter(req.query.priority);
  if (invalid) throw Object.assign(new Error('Invalid filter'), { status: 400 });
  if (priority !== null) filter.isPriority = priorityCondition(priority);
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
      .select('fullName phone fields leadCreatedAt createdAt assignedTo isPriority convertedClient convertedClientName adminStatus')
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
  else if (isObjectId(assignedTo)) filter.assignedTo = assignedTo;
  if (statusId === 'none') filter.status = null;
  else if (isObjectId(statusId)) filter.status = statusId;
  const { priority, invalid } = readPriorityFilter(req.query.priority);
  if (invalid) throw Object.assign(new Error('Invalid filter'), { status: 400 });
  if (priority !== null) filter.isPriority = priorityCondition(priority);
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
      .select('fullName phone fields createdAt assignedTo assignedAt isPriority convertedClient convertedClientName statusName statusColor status')
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
  else if (isObjectId(assignedTo)) filter.assignedTo = assignedTo;
  if (statusId === 'none') filter.status = null;
  else if (isObjectId(statusId)) filter.status = statusId;
  if (manualSource === 'manual' || manualSource === 'import') filter.source = manualSource;
  const { priority, invalid } = readPriorityFilter(req.query.priority);
  if (invalid) throw Object.assign(new Error('Invalid filter'), { status: 400 });
  if (priority !== null) filter.isPriority = priorityCondition(priority);
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
      .select('fullName phone address source createdAt assignedTo assignedAt isPriority convertedClient convertedClientName statusName statusColor status')
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
      .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt) || String(b._id).localeCompare(String(a._id)));
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

module.exports = { listAllLeads };

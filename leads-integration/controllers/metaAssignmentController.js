const mongoose = require('mongoose');
const User = require('../models/User');
const MetaLead = require('../models/MetaLead');
const { sessionFilter, narrowRange } = require('../utils/sessionScope');
const ManualLead = require('../models/ManualLead');
const WebsiteLead = require('../models/WebsiteLead');
const Lead = require('../models/Lead');
const MetaLeadStatus = require('../models/MetaLeadStatus');
const MetaLeadAssignment = require('../models/MetaLeadAssignment');
const { STATUS_COLORS } = require('../models/MetaLeadStatus');
const { logMetaEvent, logMetaError } = require('../utils/metaLogger');
const { startRegistrationForMetaLead, startRegistrationForInboxLead } = require('./registrationController');
const { detailFields, sourceLabelFor } = require('./inboxLeadController');
const { readPriorityFilter, priorityCondition } = require('../utils/leadPriority');
const { readScheduledAt, rescheduleUpdate, statusLogEntry } = require('../utils/leadSchedule');
const { applyLeadAssignments } = require('../utils/leadAssignment');
const { companyObjectId, leadCompanyFilter } = require('../utils/tenant');
const { assignedScope } = require('../utils/leadScope');
const { assertLeadStatusMutable, assertLeadsAssignmentMutable } = require('../utils/leadStatusLock');

// Every query on leads, assignments, statuses and users in this file is scoped to the signed-in company.
const tenantFilter = (req, extra = {}) => ({ ...leadCompanyFilter(req.leadsCompanyId), ...extra });

const MAX_BULK_ASSIGN = 500;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_NAME_LENGTH = 40;
const MAX_REMARK_LENGTH = 1000;
const MAX_SEARCH_LENGTH = 100;

// Statuses created the first time the pipeline is used - the owner can rename, recolour and reorder them, and add more.
// One is the converted status (the lead became a client) and one the lost status; both always exist.
const DEFAULT_STATUSES = [
  { name: 'New', color: 'slate' },
  { name: 'Interested', color: 'amber' },
  { name: 'Callback', color: 'blue' },
  { name: 'Site visit', color: 'purple' },
  { name: 'Converted', color: 'emerald', outcome: 'converted', isConversion: true },
  { name: 'Lost', color: 'rose', outcome: 'lost' },
];
const OUTCOMES = ['open', 'converted', 'lost'];

const isObjectId = (value) => typeof value === 'string' && mongoose.isValidObjectId(value);
const toStringParam = (value) => (typeof value === 'string' ? value.trim() : '');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const serverError = (res, error, message) => {
  logMetaError('META_INTERNAL_ERROR', { reason: error.name });
  return res.status(500).json({ message });
};

const parseDateRange = (query) => {
  const from = toStringParam(query.from);
  const to = toStringParam(query.to);
  const range = {};
  if (from) range.$gte = new Date(from);
  if (to) range.$lte = new Date(to);
  const invalid = Object.values(range).some((date) => Number.isNaN(date.getTime()));
  return { range: Object.keys(range).length ? range : null, invalid };
};

// ---------------------------------------------------------------------------
// Lead statuses (managed by admin / manager)
// ---------------------------------------------------------------------------

const ensureDefaultStatuses = async (companyId) => {
  const base = leadCompanyFilter(companyId);
  if ((await MetaLeadStatus.countDocuments(base)) === 0) {
    try {
      await MetaLeadStatus.insertMany(
        DEFAULT_STATUSES.map((status, index) => ({
          ...status,
          company: companyId,
          nameKey: status.name.toLowerCase(),
          order: index,
        })),
        { ordered: false }
      );
    } catch (error) {
      // Another request created them at the same moment
      if (error.code !== 11000 && !(error.writeErrors || []).length) throw error;
    }
  }
  await ensureOutcomes(companyId);
};

/**
 * Every company has exactly one converted and one lost status. Companies from before outcomes existed get them
 * here: the status flagged as conversion becomes "converted", one named Not interested / Lost becomes "lost",
 * and if nothing fits, the status is created.
 */
const ensureOutcomes = async (companyId) => {
  const base = { ...leadCompanyFilter(companyId), isDeleted: false };
  const live = await MetaLeadStatus.find(base).sort({ order: 1, createdAt: 1 });
  const last = live.reduce((n, st) => Math.max(n, st.order), -1);
  const fix = async (outcome, pick, fallback) => {
    const holders = live.filter((st) => st.outcome === outcome);
    if (holders.length === 1) return;
    if (holders.length > 1) {
      // keep the first; the others go back to being ordinary steps
      await MetaLeadStatus.updateMany({ _id: { $in: holders.slice(1).map((st) => st._id) } }, { $set: { outcome: 'open', ...(outcome === 'converted' ? { isConversion: false } : {}) } });
      return;
    }
    const chosen = live.find(pick);
    if (chosen) {
      await MetaLeadStatus.updateOne({ _id: chosen._id }, { $set: { outcome, isActive: true, isConversion: outcome === 'converted' } });
      chosen.outcome = outcome;
    } else {
      try {
        await MetaLeadStatus.create({ ...fallback, company: companyId, nameKey: fallback.name.toLowerCase(), order: last + 1 + (outcome === 'lost' ? 1 : 0) });
      } catch (error) {
        if (error.code !== 11000) throw error; // created by a request running at the same moment
      }
    }
  };
  await fix('converted', (st) => st.outcome === 'open' && (st.isConversion || st.nameKey === 'converted'), DEFAULT_STATUSES[4]);
  await fix('lost', (st) => st.outcome === 'open' && ['not interested', 'lost'].includes(st.nameKey), DEFAULT_STATUSES[5]);
};

const serializeStatus = (status) => ({
  _id: status._id,
  name: status.name,
  color: status.color,
  order: status.order,
  outcome: status.outcome || 'open',
  isConversion: status.isConversion,
  requiresDate: Boolean(status.requiresDate),
  isActive: status.isActive,
});

const readStatusInput = (body, { partial = false } = {}) => {
  const input = {};
  const errors = [];

  if (body.name !== undefined || !partial) {
    const name = toStringParam(body.name).replace(/\s+/g, ' ');
    if (!name || name.length > MAX_NAME_LENGTH) errors.push(`Status name is required (max ${MAX_NAME_LENGTH} characters)`);
    input.name = name;
    input.nameKey = name.toLowerCase();
  }
  if (body.color !== undefined) {
    if (!STATUS_COLORS.includes(body.color)) errors.push('Invalid status colour');
    input.color = body.color;
  }
  if (body.outcome !== undefined) {
    if (!OUTCOMES.includes(body.outcome)) errors.push('Choose what this status means');
    input.outcome = body.outcome;
    input.isConversion = body.outcome === 'converted';
  }
  if (body.isActive !== undefined) input.isActive = body.isActive === true;
  if (body.requiresDate !== undefined) input.requiresDate = body.requiresDate === true;

  return { input, error: errors[0] || null };
};

/** The converted and lost statuses must always exist and be usable: they can't be switched off or turned ordinary. */
const outcomeGuard = (current, input) => {
  const special = current.outcome === 'converted' || current.outcome === 'lost';
  if (!special) return null;
  if (input.outcome !== undefined && input.outcome !== current.outcome) {
    return `“${current.name}” is your ${current.outcome} status. To change that, make another status the ${current.outcome} one — this one then becomes an ordinary step.`;
  }
  if (input.isActive === false) return `The ${current.outcome} status can’t be switched off — every company needs one.`;
  return null;
};

/** A status that now holds the converted or lost role takes it from the one that had it (there is only one of each). */
const takeOverOutcome = async (req, status) => {
  if (!status || (status.outcome !== 'converted' && status.outcome !== 'lost')) return;
  await MetaLeadStatus.updateMany(
    tenantFilter(req, { _id: { $ne: status._id }, outcome: status.outcome, isDeleted: false }),
    { $set: { outcome: 'open', ...(status.outcome === 'converted' ? { isConversion: false } : {}) } }
  );
};

// @desc    List lead statuses (telecallers only receive the active ones)
// @route   GET /api/integrations/meta/lead-statuses
// @access  Private (admin, manager, telecaller)
const getLeadStatuses = async (req, res) => {
  try {
    await ensureDefaultStatuses(req.leadsCompanyId);

    const filter = tenantFilter(req, { isDeleted: false });
    if (req.user.role !== 'company') filter.isActive = true; // staff pick from the active statuses only

    const statuses = await MetaLeadStatus.find(filter).sort({ order: 1, createdAt: 1 });
    res.json(statuses.map(serializeStatus));
  } catch (error) {
    serverError(res, error, 'Server error retrieving lead statuses');
  }
};

// @desc    Create a lead status
// @route   POST /api/integrations/meta/lead-statuses
// @access  Private (admin, manager)
const createLeadStatus = async (req, res) => {
  const { input, error } = readStatusInput(req.body || {});
  if (error) return res.status(400).json({ message: error });

  try {
    await ensureDefaultStatuses(req.leadsCompanyId);
    const last = await MetaLeadStatus.findOne(tenantFilter(req, { isDeleted: false })).sort({ order: -1 });
    const status = await MetaLeadStatus.create({ ...input, isActive: true, company: req.leadsCompanyId, order: last ? last.order + 1 : 0 });
    await takeOverOutcome(req, status);

    logMetaEvent('META_LEAD_STATUS_CREATED', { userId: String(req.user._id), statusId: String(status._id) });
    res.status(201).json(serializeStatus(status));
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'A status with this name already exists' });
    serverError(res, err, 'Server error creating lead status');
  }
};

// @desc    Update a lead status (name, colour, conversion flag, active)
// @route   PUT /api/integrations/meta/lead-statuses/:id
// @access  Private (admin, manager)
const updateLeadStatus = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead status not found' });

  const { input, error } = readStatusInput(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ message: error });

  try {
    const current = await MetaLeadStatus.findOne(tenantFilter(req, { _id: req.params.id, isDeleted: false }));
    if (!current) return res.status(404).json({ message: 'Lead status not found' });
    const guard = outcomeGuard(current, input);
    if (guard) return res.status(400).json({ message: guard });
    const status = await MetaLeadStatus.findOneAndUpdate(
      tenantFilter(req, { _id: req.params.id, isDeleted: false }),
      { $set: input },
      { returnDocument: 'after', runValidators: true }
    );
    await takeOverOutcome(req, status);

    res.json(serializeStatus(status));
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'A status with this name already exists' });
    serverError(res, err, 'Server error updating lead status');
  }
};

// @desc    Change the order of the lead statuses
// @route   PUT /api/integrations/meta/lead-statuses/reorder
// @access  Private (admin, manager)
const reorderLeadStatuses = async (req, res) => {
  const statusIds = Array.isArray(req.body && req.body.statusIds) ? req.body.statusIds : [];
  if (statusIds.length === 0 || statusIds.length > 200 || !statusIds.every(isObjectId)) {
    return res.status(400).json({ message: 'Invalid status order' });
  }

  try {
    const tenant = leadCompanyFilter(req.leadsCompanyId);
    await MetaLeadStatus.bulkWrite(
      statusIds.map((id, index) => ({
        updateOne: { filter: { ...tenant, _id: id, isDeleted: false }, update: { $set: { order: index } } },
      }))
    );
    const statuses = await MetaLeadStatus.find(tenantFilter(req, { isDeleted: false })).sort({ order: 1, createdAt: 1 });
    res.json(statuses.map(serializeStatus));
  } catch (error) {
    serverError(res, error, 'Server error reordering lead statuses');
  }
};

// @desc    Delete a lead status (leads keep it in their history)
// @route   DELETE /api/integrations/meta/lead-statuses/:id
// @access  Private (admin, manager)
const deleteLeadStatus = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead status not found' });

  try {
    const current = await MetaLeadStatus.findOne(tenantFilter(req, { _id: req.params.id, isDeleted: false })).lean();
    if (!current) return res.status(404).json({ message: 'Lead status not found' });
    if (current.outcome === 'converted' || current.outcome === 'lost') {
      return res.status(400).json({ message: `“${current.name}” is your ${current.outcome} status, which every company needs. Make another status the ${current.outcome} one first.` });
    }
    const status = await MetaLeadStatus.findOneAndUpdate(
      tenantFilter(req, { _id: req.params.id, isDeleted: false }),
      { $set: { isDeleted: true, isActive: false } }
    );
    if (!status) return res.status(404).json({ message: 'Lead status not found' });

    logMetaEvent('META_LEAD_STATUS_DELETED', { userId: String(req.user._id), statusId: String(status._id) });
    res.json({ message: 'Lead status deleted' });
  } catch (error) {
    serverError(res, error, 'Server error deleting lead status');
  }
};

// ---------------------------------------------------------------------------
// Assignment (admin / manager)
// ---------------------------------------------------------------------------

// @desc    Assign or reassign Meta leads in bulk to a telecaller (telecallerId: null = unassign)
// @route   POST /api/integrations/meta/leads/assign
// @access  Private (admin, manager)
const assignMetaLeads = async (req, res) => {
  const body = req.body || {};
  const leadIds = Array.isArray(body.leadIds) ? [...new Set(body.leadIds)] : [];
  const requestedId = body.counsellorId !== undefined ? body.counsellorId : body.telecallerId;
  const telecallerId = requestedId || null;

  if (leadIds.length === 0 || !leadIds.every(isObjectId)) {
    return res.status(400).json({ message: 'Select at least one lead' });
  }
  if (leadIds.length > MAX_BULK_ASSIGN) {
    return res.status(400).json({ message: `You can assign up to ${MAX_BULK_ASSIGN} leads at a time` });
  }
  if (telecallerId && !isObjectId(telecallerId)) {
    return res.status(400).json({ message: 'Invalid counsellor' });
  }

  try {
    // the staff member was checked by the main app (same company, active, may hold leads): req.leadsAssignee
    let telecaller = null;
    if (telecallerId) {
      telecaller = req.leadsAssignee && String(req.leadsAssignee._id) === String(telecallerId) ? req.leadsAssignee : null;
      if (!telecaller) return res.status(404).json({ message: 'Staff member not found, inactive, or not allowed to work on leads' });
    }

    const leads = await MetaLead.find(
      tenantFilter(req, { _id: { $in: leadIds }, processingStatus: 'processed', isDeleted: false, ...assignedScope(req) })
    )
      .select('_id assignedTo assignedAt assignmentHistory convertedClient adminStatus')
      .populate('assignedTo', 'name email')
      .lean();

    // Leads that already belong to the requested telecaller are left as they are
    const targetId = telecaller ? String(telecaller._id) : '';
    const toChange = leads.filter((lead) => String(lead.assignedTo?._id || '') !== targetId);
    const changeIds = toChange.map((lead) => lead._id);
    if (changeIds.length) {
      const assignments = await MetaLeadAssignment.find(tenantFilter(req, { lead: { $in: changeIds }, isActive: true }))
        .select('lead currentStatus')
        .lean();
      const statusByLead = new Map(assignments.map((a) => [String(a.lead), a.currentStatus]));
      const lock = await assertLeadsAssignmentMutable(req.leadsCompanyId, toChange, (lead) => ({
        convertedClient: lead.convertedClient,
        adminStatus: lead.adminStatus,
        currentStatus: statusByLead.get(String(lead._id)),
      }));
      if (!lock.ok) return res.status(lock.status).json({ message: lock.message });
    }
    const now = new Date();

    if (changeIds.length > 0) {
      // 1. The current owner's record becomes read-only (their status track is kept as it is)
      await MetaLeadAssignment.updateMany(
        tenantFilter(req, { lead: { $in: changeIds }, isActive: true }),
        { $set: { isActive: false, endedAt: now } }
      );

      if (telecaller) {
        // 2. The new owner gets their own record. A telecaller who had the lead before
        //    gets their earlier record back, with the progress they had made.
        await MetaLeadAssignment.bulkWrite(
          changeIds.map((lead) => ({
            updateOne: {
              filter: { company: companyObjectId(req.leadsCompanyId), lead, telecaller: telecaller._id },
              update: {
                $set: { source: 'META', isActive: true, assignedBy: req.user._id, assignedAt: now },
                $unset: { endedAt: 1 },
                $setOnInsert: { currentStatus: null, history: [] },
              },
              upsert: true,
            },
          })),
          { ordered: false }
        );
      }
      await applyLeadAssignments(MetaLead, tenantFilter(req), toChange, telecaller, req.user, now); // history, flags and log per lead
    }

    logMetaEvent('META_LEADS_ASSIGNED', {
      userId: String(req.user._id),
      telecallerId: targetId || null,
      count: changeIds.length,
    });

    res.json({
      message: telecaller
        ? `${changeIds.length} lead(s) assigned to ${telecaller.name}`
        : `${changeIds.length} lead(s) unassigned`,
      assigned: changeIds.length,
      unchanged: leads.length - changeIds.length,
      notFound: leadIds.length - leads.length,
    });
  } catch (error) {
    if (error.code === 11000 || (error.writeErrors || []).length) {
      return res.status(409).json({ message: 'These leads were just changed by someone else. Please try again.' });
    }
    serverError(res, error, 'Server error assigning leads');
  }
};

const serializeHistory = (history) =>
  (history || []).map((entry) => ({
    statusName: entry.statusName,
    statusColor: entry.statusColor,
    remark: entry.remark,
    scheduledAt: entry.scheduledAt || null,
    rescheduled: Boolean(entry.rescheduled),
    changedAt: entry.changedAt,
  }));

const serializeCurrentStatus = (status) =>
  status ? { _id: status._id, name: status.name, color: status.color, isConversion: status.isConversion, requiresDate: Boolean(status.requiresDate) } : null;

// @desc    Every telecaller's work on one lead (each telecaller has a separate status track)
// @route   GET /api/integrations/meta/leads/:id/assignments
// @access  Private (admin, manager)
const getMetaLeadAssignments = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead not found' });

  try {
    if (req.leadsAssignedTo && !(await MetaLead.exists(tenantFilter(req, { _id: req.params.id, ...assignedScope(req) })))) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    const assignments = await MetaLeadAssignment.find(tenantFilter(req, { lead: req.params.id }))
      .populate('telecaller', 'name email')
      .populate('assignedBy', 'name')
      .populate('currentStatus', 'name color isConversion')
      .sort({ isActive: -1, assignedAt: -1 });

    res.json(
      assignments.map((assignment) => ({
        _id: assignment._id,
        telecaller: assignment.telecaller,
        assignedBy: assignment.assignedBy,
        assignedAt: assignment.assignedAt,
        endedAt: assignment.endedAt || null,
        isActive: assignment.isActive,
        currentStatus: serializeCurrentStatus(assignment.currentStatus),
        history: serializeHistory(assignment.history),
        lastActivityAt: assignment.lastActivityAt || null,
      }))
    );
  } catch (error) {
    serverError(res, error, 'Server error retrieving lead assignments');
  }
};

// ---------------------------------------------------------------------------
// Performance report (admin / manager)
// ---------------------------------------------------------------------------

// @desc    Performance of every telecaller on Meta leads (optionally for leads assigned within a date range)
// @route   GET /api/integrations/meta/reports/telecallers?from=&to=
// @access  Private (admin, manager)
const getTelecallerReport = async (req, res) => {
  const { range: pageRange, invalid } = parseDateRange(req.query);
  if (invalid) return res.status(400).json({ message: 'Invalid date filter' });
  // Page date filter is applied within the selected session's range
  const range = narrowRange(req, pageRange && pageRange.$gte, pageRange && pageRange.$lte);

  try {
    await ensureDefaultStatuses(req.leadsCompanyId);
    const statuses = await MetaLeadStatus.find(leadCompanyFilter(req.leadsCompanyId)).sort({ order: 1, createdAt: 1 });
    const conversionIds = statuses.filter((status) => status.isConversion).map((status) => status._id);

    const match = tenantFilter(req, range ? { assignedAt: range } : {});
    const historySize = { $size: { $ifNull: ['$history', []] } };

    const [totals, breakdown] = await Promise.all([
      MetaLeadAssignment.aggregate([
        { $match: match },
        ...joinedLeadStages(),
        {
          $group: {
            _id: '$telecaller',
            totalAssigned: { $sum: 1 },
            activeLeads: { $sum: { $cond: ['$isActive', 1, 0] } },
            reassignedAway: { $sum: { $cond: ['$isActive', 0, 1] } },
            workedLeads: { $sum: { $cond: [{ $gt: [historySize, 0] }, 1, 0] } },
            notStarted: { $sum: { $cond: [{ $and: ['$isActive', { $eq: [historySize, 0] }] }, 1, 0] } },
            converted: { $sum: { $cond: [{ $in: ['$currentStatus', conversionIds] }, 1, 0] } },
            statusUpdates: { $sum: historySize },
            lastActivityAt: { $max: '$lastActivityAt' },
          },
        },
      ]),
      MetaLeadAssignment.aggregate([
        { $match: { ...match, currentStatus: { $ne: null } } },
        ...joinedLeadStages(),
        { $group: { _id: { telecaller: '$telecaller', status: '$currentStatus' }, count: { $sum: 1 } } },
      ]),
    ]);

    // Every telecaller is listed, including those without any lead yet
    // every staff member who may work on leads (resolved by the main app), plus anyone who had leads before
    const users = await User.find(tenantFilter(req, {
      _id: { $in: [...(req.leadStaffIds || []), ...totals.map((row) => row._id)] },
    }))
      .select('name email active role')
      .sort({ name: 1 });

    const totalsByUser = new Map(totals.map((row) => [String(row._id), row]));
    const statusById = new Map(statuses.map((status) => [String(status._id), status]));

    const telecallers = users.map((user) => {
      const row = totalsByUser.get(String(user._id)) || {};
      const totalAssigned = row.totalAssigned || 0;
      const converted = row.converted || 0;

      return {
        user: { _id: user._id, name: user.name, email: user.email, status: user.active === false ? 'inactive' : 'active' },
        totalAssigned,
        activeLeads: row.activeLeads || 0,
        reassignedAway: row.reassignedAway || 0,
        workedLeads: row.workedLeads || 0,
        notStarted: row.notStarted || 0,
        converted,
        conversionRate: totalAssigned ? Math.round((converted / totalAssigned) * 1000) / 10 : 0,
        statusUpdates: row.statusUpdates || 0,
        lastActivityAt: row.lastActivityAt || null,
        statuses: breakdown
          .filter((entry) => String(entry._id.telecaller) === String(user._id) && statusById.has(String(entry._id.status)))
          .map((entry) => {
            const status = statusById.get(String(entry._id.status));
            return { statusId: status._id, name: status.name, color: status.color, order: status.order, count: entry.count };
          })
          .sort((a, b) => a.order - b.order),
      };
    });

    const open = { $or: [{ assignedTo: { $exists: false } }, { assignedTo: null }] };
    const [metaTotal, manualTotal, websiteTotal, metaOpen, manualOpen, websiteOpen] = await Promise.all([
      MetaLead.countDocuments(tenantFilter(req, { processingStatus: 'processed', isDeleted: false })),
      ManualLead.countDocuments(tenantFilter(req, { isDeleted: { $ne: true } })),
      WebsiteLead.countDocuments(tenantFilter(req, { isDeleted: { $ne: true } })),
      MetaLead.countDocuments(tenantFilter(req, { processingStatus: 'processed', isDeleted: false, ...open })),
      ManualLead.countDocuments(tenantFilter(req, { isDeleted: { $ne: true }, ...open })),
      WebsiteLead.countDocuments(tenantFilter(req, { isDeleted: { $ne: true }, ...open })),
    ]);
    const totalLeads = metaTotal + manualTotal + websiteTotal;
    const unassignedLeads = metaOpen + manualOpen + websiteOpen;

    res.json({ totalLeads, unassignedLeads, telecallers });
  } catch (error) {
    serverError(res, error, 'Server error building the performance report');
  }
};

// @desc    Every lead assigned to one counsellor (their tasks), including leads later given to someone else
// @route   GET /api/integrations/meta/reports/telecallers/:id?state=&page=&limit=&search=&statusId=&source=&priority=&from=&to=
// @access  Private (admin, manager)
const getTelecallerTasks = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Counsellor not found' });

  const page = Math.max(parseInt(toStringParam(req.query.page), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(toStringParam(req.query.limit), 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const search = toStringParam(req.query.search).slice(0, MAX_SEARCH_LENGTH).toLowerCase();
  const statusId = toStringParam(req.query.statusId);
  const source = toStringParam(req.query.source);
  const state = toStringParam(req.query.state) || 'all';
  const { priority, invalid: invalidPriority } = readPriorityFilter(req.query.priority);
  const sourceMatch = {
    meta: { 'leadDoc.bucket': 'META' },
    website: { 'leadDoc.bucket': 'WEBSITE' },
    upload: { 'leadDoc.bucket': 'MANUAL', 'leadDoc.channel': 'upload' },
    form: { 'leadDoc.bucket': 'MANUAL', 'leadDoc.channel': 'form' },
  }[source];

  if (!['all', 'active', 'previous'].includes(state)) {
    return res.status(400).json({ message: 'Invalid task filter' });
  }
  if (source && !sourceMatch) return res.status(400).json({ message: 'Invalid source filter' });
  if (invalidPriority) return res.status(400).json({ message: 'Invalid priority filter' });
  if (statusId && statusId !== 'none' && !isObjectId(statusId)) {
    return res.status(400).json({ message: 'Invalid status filter' });
  }

  const { range: pageRange, invalid } = parseDateRange(req.query);
  if (invalid) return res.status(400).json({ message: 'Invalid date filter' });
  const assignedRange = narrowRange(req, pageRange && pageRange.$gte, pageRange && pageRange.$lte);

  try {
    const user = await User.findOne(tenantFilter(req, { _id: req.params.id })).select('name email active role');
    const hasTasks = user && (user.role === 'agent' || (await MetaLeadAssignment.exists(tenantFilter(req, { telecaller: user._id }))));
    if (!hasTasks) return res.status(404).json({ message: 'Counsellor not found' });

    const base = tenantFilter(req, { telecaller: user._id });
    const receivedStages = [];
    if (assignedRange) {
      const received = { $ifNull: ['$leadDoc.leadCreatedAt', '$leadDoc.createdAt'] };
      const bounds = [];
      if (assignedRange.$gte) bounds.push({ $gte: [received, assignedRange.$gte] });
      if (assignedRange.$lte) bounds.push({ $lte: [received, assignedRange.$lte] });
      receivedStages.push({ $match: { $expr: bounds.length > 1 ? { $and: bounds } : bounds[0] } });
    }
    const filter = { ...base };
    if (state === 'active') filter.isActive = true;
    if (state === 'previous') filter.isActive = false;
    if (statusId === 'none') filter.currentStatus = null;
    else if (statusId) filter.currentStatus = new mongoose.Types.ObjectId(statusId);

    const joins = joinedLeadStages();
    const searchStage = [
      ...(search ? [{ $match: { 'leadDoc.searchText': { $regex: escapeRegex(search) } } }] : []),
      ...(sourceMatch ? [{ $match: sourceMatch }] : []),
      ...(priority !== null ? [{ $match: { 'leadDoc.isPriority': priorityCondition(priority) } }] : []),
      ...receivedStages,
    ];
    const statusLookup = {
      $lookup: {
        from: MetaLeadStatus.collection.name,
        localField: 'currentStatus',
        foreignField: '_id',
        as: 'statusDoc',
      },
    };

    const [rows, filteredCount, allCount, activeCount, previousCount] = await Promise.all([
      MetaLeadAssignment.aggregate([
        { $match: filter },
        ...joins,
        ...searchStage,
        { $addFields: { receivedAt: { $ifNull: ['$leadDoc.leadCreatedAt', '$leadDoc.createdAt'] } } },
        { $sort: { receivedAt: -1, _id: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        statusLookup,
        crmLookup,
      ]),
      MetaLeadAssignment.aggregate([{ $match: filter }, ...joins, ...searchStage, { $count: 'n' }]),
      MetaLeadAssignment.aggregate([{ $match: base }, ...joins, { $count: 'n' }]),
      MetaLeadAssignment.aggregate([{ $match: { ...base, isActive: true } }, ...joins, { $count: 'n' }]),
      MetaLeadAssignment.aggregate([{ $match: { ...base, isActive: false } }, ...joins, { $count: 'n' }]),
    ]);

    const total = filteredCount[0]?.n || 0;
    res.json({
      counsellor: {
        _id: user._id,
        name: user.name,
        email: user.email,
        status: user.active === false ? 'inactive' : 'active',
      },
      tasks: rows.map((row) => ({
        _id: row._id,
        isActive: row.isActive,
        assignedAt: row.assignedAt,
        endedAt: row.endedAt || null,
        currentStatus: serializeCurrentStatus(row.statusDoc && row.statusDoc[0]),
        history: serializeHistory(row.history),
        lastActivityAt: row.lastActivityAt || null,
        lead: shapeJoinedLead(row.leadDoc, row.crmDoc && row.crmDoc[0]),
      })),
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
      counts: {
        all: allCount[0]?.n || 0,
        active: activeCount[0]?.n || 0,
        previous: previousCount[0]?.n || 0,
      },
    });
  } catch (error) {
    serverError(res, error, 'Server error retrieving counsellor tasks');
  }
};

// ---------------------------------------------------------------------------
// Telecaller: my leads
// ---------------------------------------------------------------------------

const serializeMyAssignment = (assignment) => ({
  _id: assignment._id,
  // Leads that were reassigned to someone else stay visible but are read-only
  isActive: assignment.isActive,
  assignedAt: assignment.assignedAt,
  endedAt: assignment.endedAt || null,
  currentStatus: serializeCurrentStatus(assignment.currentStatus),
  history: serializeHistory(assignment.history),
  lastActivityAt: assignment.lastActivityAt || null,
  lead: assignment.lead,
});

// One counsellor list reads Meta, uploaded/added, and website leads together.
const joinedLeadStages = () => [
  {
    $lookup: {
      from: MetaLead.collection.name,
      let: { leadId: '$lead', src: { $ifNull: ['$source', 'META'] } },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$$src', 'META'] },
                { $eq: ['$_id', '$$leadId'] },
                { $ne: ['$isDeleted', true] },
              ],
            },
          },
        },
        {
          $project: {
            fullName: 1,
            email: 1,
            phone: 1,
            fields: 1,
            formName: 1,
            pageName: 1,
            crmLead: 1,
            leadCreatedAt: 1,
            createdAt: 1,
            searchText: 1,
            isPriority: 1,
            bucket: { $literal: 'META' },
          },
        },
      ],
      as: 'fromMeta',
    },
  },
  {
    $lookup: {
      from: ManualLead.collection.name,
      let: { leadId: '$lead', src: { $ifNull: ['$source', 'META'] } },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$$src', 'MANUAL'] },
                { $eq: ['$_id', '$$leadId'] },
                { $ne: ['$isDeleted', true] },
              ],
            },
          },
        },
        {
          $project: {
            fullName: '$name',
            email: 1,
            phone: 1,
            qualification: 1,
            address: 1,
            parentEmail: 1,
            alternatePhone: 1,
            crmLead: 1,
            createdAt: 1,
            searchText: 1,
            isPriority: 1,
            channel: '$source',
            bucket: { $literal: 'MANUAL' },
          },
        },
      ],
      as: 'fromManual',
    },
  },
  {
    $lookup: {
      from: WebsiteLead.collection.name,
      let: { leadId: '$lead', src: { $ifNull: ['$source', 'META'] } },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$$src', 'WEBSITE'] },
                { $eq: ['$_id', '$$leadId'] },
                { $ne: ['$isDeleted', true] },
              ],
            },
          },
        },
        {
          $project: {
            fullName: '$name',
            email: 1,
            phone: 1,
            parentEmail: 1,
            alternatePhone: 1,
            crmLead: 1,
            createdAt: 1,
            searchText: 1,
            isPriority: 1,
            channel: { $literal: 'website' },
            bucket: { $literal: 'WEBSITE' },
          },
        },
      ],
      as: 'fromWebsite',
    },
  },
  {
    $addFields: {
      leadDoc: {
        $arrayElemAt: [{ $concatArrays: ['$fromMeta', '$fromManual', '$fromWebsite'] }, 0],
      },
    },
  },
  { $match: { leadDoc: { $type: 'object' } } },
];

const shapeJoinedLead = (lead, crm) => {
  const sourceLabel = lead.bucket === 'META' ? 'Meta' : sourceLabelFor(lead.channel);
  const fields = lead.bucket === 'META'
    ? (lead.fields || {})
    : detailFields({
      name: lead.fullName,
      email: lead.email,
      phone: lead.phone,
      qualification: lead.qualification,
      address: lead.address,
      parentEmail: lead.parentEmail,
      alternatePhone: lead.alternatePhone,
    });
  const formSubmitted = Boolean(crm?.formSubmittedAt);
  return {
    _id: lead._id,
    fullName: lead.fullName || '',
    email: lead.email || '',
    phone: lead.phone || '',
    fields,
    formName: lead.formName || '',
    pageName: lead.pageName || '',
    source: lead.bucket,
    sourceLabel,
    isPriority: Boolean(lead.isPriority),
    leadCreatedAt: lead.leadCreatedAt,
    createdAt: lead.createdAt,
    crmLead: crm
      ? {
        registrationBy: crm.registrationBy,
        formSubmitted,
        registrationPath: crm.registrationToken && !formSubmitted ? `/register/${crm.registrationToken}` : null,
      }
      : null,
  };
};

const crmLookup = {
  $lookup: {
    from: Lead.collection.name,
    localField: 'leadDoc.crmLead',
    foreignField: '_id',
    as: 'crmDoc',
  },
};

// @desc    Leads assigned to the logged-in counsellor (state=active) or reassigned away from them (state=previous)
// @route   GET /api/integrations/meta/my-leads?state=&page=&limit=&search=&statusId=&priority=
// @access  Private (counsellor)
const getMyMetaLeads = async (req, res) => {
  const page = Math.max(parseInt(toStringParam(req.query.page), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(toStringParam(req.query.limit), 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const search = toStringParam(req.query.search).slice(0, MAX_SEARCH_LENGTH).toLowerCase();
  const statusId = toStringParam(req.query.statusId);
  const isActive = toStringParam(req.query.state) !== 'previous';
  const { priority, invalid: invalidPriority } = readPriorityFilter(req.query.priority);

  if (statusId && statusId !== 'none' && !isObjectId(statusId)) {
    return res.status(400).json({ message: 'Invalid status filter' });
  }
  if (invalidPriority) return res.status(400).json({ message: 'Invalid priority filter' });

  const userId = req.user._id;
  const filter = tenantFilter(req, { telecaller: userId, isActive, ...sessionFilter(req, 'assignedAt') });
  if (statusId === 'none') filter.currentStatus = null;
  else if (statusId) filter.currentStatus = new mongoose.Types.ObjectId(statusId);

  const joins = joinedLeadStages();
  const searchStage = [
    ...(search ? [{ $match: { 'leadDoc.searchText': { $regex: escapeRegex(search) } } }] : []),
    ...(priority !== null ? [{ $match: { 'leadDoc.isPriority': priorityCondition(priority) } }] : []),
  ];
  const statusLookup = {
    $lookup: {
      from: MetaLeadStatus.collection.name,
      localField: 'currentStatus',
      foreignField: '_id',
      as: 'statusDoc',
    },
  };

  try {
    const [rows, filteredCount, activeCount, previousCount] = await Promise.all([
      MetaLeadAssignment.aggregate([
        { $match: filter },
        ...joins,
        ...searchStage,
        { $sort: { assignedAt: -1, _id: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        statusLookup,
        crmLookup,
      ]),
      MetaLeadAssignment.aggregate([
        { $match: filter },
        ...joins,
        ...searchStage,
        { $count: 'n' },
      ]),
      MetaLeadAssignment.aggregate([
        { $match: tenantFilter(req, { telecaller: userId, isActive: true, ...sessionFilter(req, 'assignedAt') }) },
        ...joins,
        { $count: 'n' },
      ]),
      MetaLeadAssignment.aggregate([
        { $match: tenantFilter(req, { telecaller: userId, isActive: false, ...sessionFilter(req, 'assignedAt') }) },
        ...joins,
        { $count: 'n' },
      ]),
    ]);

    const total = filteredCount[0]?.n || 0;
    res.json({
      assignments: rows.map((row) => ({
        _id: row._id,
        isActive: row.isActive,
        assignedAt: row.assignedAt,
        endedAt: row.endedAt || null,
        currentStatus: serializeCurrentStatus(row.statusDoc && row.statusDoc[0]),
        history: serializeHistory(row.history),
        lastActivityAt: row.lastActivityAt || null,
        lead: shapeJoinedLead(row.leadDoc, row.crmDoc && row.crmDoc[0]),
      })),
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
      counts: {
        active: activeCount[0]?.n || 0,
        previous: previousCount[0]?.n || 0,
      },
    });
  } catch (error) {
    serverError(res, error, 'Server error retrieving your leads');
  }
};

// @desc    Admin or manager sets the status of any lead on its current counsellor
// @route   PUT /api/integrations/meta/leads/:id/status
// @access  Private (admin, manager)
const updateMetaLeadStatus = async (req, res) => {
  const body = req.body || {};
  const remark = toStringParam(body.remark).slice(0, MAX_REMARK_LENGTH);

  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead not found' });
  if (!isObjectId(body.statusId)) return res.status(400).json({ message: 'Select a status' });

  try {
    const status = await MetaLeadStatus.findOne(tenantFilter(req, { _id: body.statusId, isActive: true, isDeleted: false }));
    if (!status) return res.status(400).json({ message: 'This status is no longer available' });
    const { scheduledAt, error: dateError } = readScheduledAt(body, status);
    if (dateError) return res.status(400).json({ message: dateError });

    const metaLead = await MetaLead.findOne(tenantFilter(req, { _id: req.params.id, isDeleted: { $ne: true }, ...assignedScope(req) }))
      .select('convertedClient adminStatus scheduledAt rescheduledCount')
      .lean();
    if (!metaLead) return res.status(404).json({ message: 'Lead not found' });

    const assignmentPeek = await MetaLeadAssignment.findOne(tenantFilter(req, { lead: req.params.id, isActive: true }))
      .select('currentStatus')
      .lean();
    const lock = await assertLeadStatusMutable(req.leadsCompanyId, {
      convertedClient: metaLead.convertedClient,
      adminStatus: metaLead.adminStatus,
      currentStatus: assignmentPeek?.currentStatus,
    });
    if (!lock.ok) return res.status(lock.status).json({ message: lock.message });

    const now = new Date();
    const move = rescheduleUpdate(metaLead, scheduledAt, { statusName: status.name, byName: req.user.name || req.user.email || '', at: now });
    const historyEntry = {
      status: status._id,
      statusName: status.name,
      statusColor: status.color,
      remark,
      scheduledAt,
      rescheduled: move.rescheduled,
      changedAt: now,
    };
    const assignment = await MetaLeadAssignment.findOneAndUpdate(
      tenantFilter(req, { lead: req.params.id, isActive: true }),
      {
        $set: {
          currentStatus: status._id,
          lastActivityAt: now,
          pendingRegistrationStatus: null,
          pendingRegistrationRemark: '',
        },
        $push: { history: historyEntry },
      },
      { returnDocument: 'after' }
    ).populate('currentStatus', 'name color isConversion');

    // No counsellor yet: keep the status on the lead itself so it shows in the list
    // and stays until someone updates the status after the lead is assigned.
    if (!assignment) {
      const updated = await MetaLead.findOneAndUpdate(
        tenantFilter(req, { _id: req.params.id, isDeleted: { $ne: true } }),
        {
          $set: { adminStatus: status._id, adminStatusUpdatedAt: now, scheduledAt, ...move.set },
          $push: { ...move.push, logs: statusLogEntry({ status, scheduledAt, remark, rescheduled: move.rescheduled, byName: req.user.name || req.user.email || '', at: now }), adminStatusHistory: historyEntry },
        },
        { returnDocument: 'after' }
      ).populate('adminStatus', 'name color isConversion');

      logMetaEvent('META_LEAD_STATUS_UPDATED', {
        userId: String(req.user._id),
        leadId: String(req.params.id),
        statusId: String(status._id),
        byAdmin: true,
        unassigned: true,
      });

      return res.json({
        assignmentId: null,
        storedOn: 'lead',
        currentStatus: serializeCurrentStatus(updated.adminStatus),
        history: serializeHistory(updated.adminStatusHistory),
        lastActivityAt: updated.adminStatusUpdatedAt,
      });
    }

    await MetaLead.updateOne(tenantFilter(req, { _id: req.params.id }), { $set: { scheduledAt, ...move.set }, $push: { ...move.push, logs: statusLogEntry({ status, scheduledAt, remark, rescheduled: move.rescheduled, byName: req.user.name || req.user.email || '', at: now }) } });
    logMetaEvent('META_LEAD_STATUS_UPDATED', {
      userId: String(req.user._id),
      assignmentId: String(assignment._id),
      statusId: String(status._id),
      byAdmin: true,
    });

    res.json({
      assignmentId: assignment._id,
      storedOn: 'assignment',
      currentStatus: serializeCurrentStatus(assignment.currentStatus),
      history: serializeHistory(assignment.history),
      lastActivityAt: assignment.lastActivityAt,
    });
  } catch (error) {
    serverError(res, error, 'Server error updating the lead status');
  }
};

// @desc    Telecaller updates their own status for a lead they currently own
// @route   PUT /api/integrations/meta/my-leads/:id/status
// @access  Private (telecaller)
const updateMyMetaLeadStatus = async (req, res) => {
  const body = req.body || {};
  const remark = toStringParam(body.remark).slice(0, MAX_REMARK_LENGTH);

  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead not found' });
  if (!isObjectId(body.statusId)) return res.status(400).json({ message: 'Select a status' });

  try {
    const status = await MetaLeadStatus.findOne(tenantFilter(req, { _id: body.statusId, isActive: true, isDeleted: false }));
    if (!status) return res.status(400).json({ message: 'This status is no longer available' });
    const { scheduledAt, error: dateError } = readScheduledAt(body, status);
    if (dateError) return res.status(400).json({ message: dateError });

    const owned = await MetaLeadAssignment.findOne(tenantFilter(req, {
      _id: req.params.id,
      telecaller: req.user._id,
      isActive: true,
    })).select('lead source currentStatus');
    if (!owned) {
      const reassigned = await MetaLeadAssignment.exists(tenantFilter(req, { _id: req.params.id, telecaller: req.user._id }));
      if (reassigned) {
        return res.status(403).json({
          message: 'This lead has been reassigned to another counsellor. You can view it but no longer change it.',
        });
      }
      return res.status(404).json({ message: 'Lead not found' });
    }

    const metaLead = await MetaLead.findOne(tenantFilter(req, { _id: owned.lead })).select('convertedClient scheduledAt rescheduledCount').lean();
    const lock = await assertLeadStatusMutable(req.leadsCompanyId, {
      convertedClient: metaLead?.convertedClient,
      currentStatus: owned.currentStatus,
    });
    if (!lock.ok) return res.status(lock.status).json({ message: lock.message });

    let registrationLead = null;
    const ownedSource = owned.source || 'META';
    if (status.isConversion && body.registrationBy) {
      registrationLead = ownedSource === 'META'
        ? await startRegistrationForMetaLead({
          metaLeadId: owned.lead,
          registrationBy: body.registrationBy,
          courseId: body.courseId,
          actor: req.user,
        })
        : await startRegistrationForInboxLead({
          leadId: owned.lead,
          source: ownedSource,
          registrationBy: body.registrationBy,
          courseId: body.courseId,
          actor: req.user,
        });
    }

    const now = new Date();
    const move = rescheduleUpdate(metaLead, scheduledAt, { statusName: status.name, byName: req.user.name || req.user.email || '', at: now });
    const statusChange = {
      status: status._id,
      statusName: status.name,
      statusColor: status.color,
      remark,
      scheduledAt,
      rescheduled: move.rescheduled,
      changedAt: now,
    };
    // Opening the form must not mark the lead registered until the form is submitted.
    const deferStatus = Boolean(registrationLead && !registrationLead.formSubmittedAt);
    const update = deferStatus
      ? {
          $set: {
            pendingRegistrationStatus: status._id,
            pendingRegistrationRemark: remark,
            lastActivityAt: now,
          },
        }
      : {
          $set: {
            currentStatus: status._id,
            lastActivityAt: now,
            pendingRegistrationStatus: null,
            pendingRegistrationRemark: '',
          },
          $push: { history: statusChange },
        };

    // Only the counsellor who currently owns the lead can change it
    const assignment = await MetaLeadAssignment.findOneAndUpdate(
      tenantFilter(req, { _id: req.params.id, telecaller: req.user._id, isActive: true }),
      update,
      { returnDocument: 'after' }
    ).populate('currentStatus', 'name color isConversion');

    if (!assignment) {
      const reassigned = await MetaLeadAssignment.exists(tenantFilter(req, { _id: req.params.id, telecaller: req.user._id }));
      if (reassigned) {
        return res.status(403).json({
          message: 'This lead has been reassigned to another counsellor. You can view it but no longer change it.',
        });
      }
      return res.status(404).json({ message: 'Lead not found' });
    }

    if (!deferStatus) await MetaLead.updateOne(tenantFilter(req, { _id: owned.lead }), { $set: { scheduledAt, ...move.set }, $push: { ...move.push, logs: statusLogEntry({ status, scheduledAt, remark, rescheduled: move.rescheduled, byName: req.user.name || req.user.email || '', at: now }) } });
    logMetaEvent('META_LEAD_STATUS_UPDATED', {
      userId: String(req.user._id),
      assignmentId: String(assignment._id),
      statusId: String(status._id),
    });
    const [joined] = await MetaLeadAssignment.aggregate([
      { $match: { _id: assignment._id } },
      ...joinedLeadStages(),
      crmLookup,
    ]);
    const plain = assignment.toObject();
    plain.currentStatus = assignment.currentStatus;
    plain.lead = joined?.leadDoc ? shapeJoinedLead(joined.leadDoc, joined.crmDoc && joined.crmDoc[0]) : null;
    const payload = serializeMyAssignment(plain);
    if (registrationLead) {
      const registration = registrationLead.toJSON();
      payload.registrationBy = registration.registrationBy;
      payload.registrationPath = registration.registrationPath || null;
      payload.formSubmitted = registration.formSubmitted;
    }
    res.json(payload);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    serverError(res, error, 'Server error updating the lead status');
  }
};

// @desc    Counsellor marks one of their current leads as a priority, or clears the flag
// @route   PUT /api/integrations/meta/my-leads/:id/priority   (id is the assignment, as in my-leads)
// @access  Private (counsellor)
const LEAD_MODELS = { META: MetaLead, MANUAL: ManualLead, WEBSITE: WebsiteLead };

const setMyLeadPriority = async (req, res) => {
  const isPriority = req.body ? req.body.isPriority : undefined;
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead not found' });
  if (typeof isPriority !== 'boolean') return res.status(400).json({ message: 'Choose whether the lead is a priority' });

  try {
    const owned = await MetaLeadAssignment.findOne(tenantFilter(req, {
      _id: req.params.id,
      telecaller: req.user._id,
      isActive: true,
    })).select('lead source').lean();
    if (!owned) {
      const reassigned = await MetaLeadAssignment.exists(tenantFilter(req, { _id: req.params.id, telecaller: req.user._id }));
      if (reassigned) {
        return res.status(403).json({
          message: 'This lead has been reassigned to another counsellor. You can view it but no longer change it.',
        });
      }
      return res.status(404).json({ message: 'Lead not found' });
    }

    const Model = LEAD_MODELS[owned.source || 'META'];
    const lead = Model && await Model.findOneAndUpdate(
      tenantFilter(req, { _id: owned.lead, isDeleted: { $ne: true } }),
      { $set: { isPriority } },
      { returnDocument: 'after' }
    ).select('_id isPriority').lean();
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    res.json({ _id: lead._id, isPriority: Boolean(lead.isPriority) });
  } catch (error) {
    serverError(res, error, 'Server error updating the lead priority');
  }
};

module.exports = {
  ensureDefaultStatuses,
  getLeadStatuses,
  createLeadStatus,
  updateLeadStatus,
  reorderLeadStatuses,
  deleteLeadStatus,
  assignMetaLeads,
  getMetaLeadAssignments,
  getTelecallerReport,
  getTelecallerTasks,
  getMyMetaLeads,
  updateMyMetaLeadStatus,
  updateMetaLeadStatus,
  setMyLeadPriority,
};

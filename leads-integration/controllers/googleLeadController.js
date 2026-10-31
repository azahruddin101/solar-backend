const crypto = require('crypto');
const mongoose = require('mongoose');
const GoogleLead = require('../models/GoogleLead');
const User = require('../models/User');
const MetaLeadStatus = require('../models/MetaLeadStatus');
const { buildSearchText } = require('../utils/leadSearchText');
const { readPriorityFilter, priorityCondition } = require('../utils/leadPriority');
const { readScheduledAt, rescheduleUpdate, statusLogEntry } = require('../utils/leadSchedule');
const { applyLeadAssignments } = require('../utils/leadAssignment');
const { resolveWebhookKey, resolveWebhookKeyFromPayload } = require('../services/googleAdsKey');
const { leadCompanyFilter } = require('../utils/tenant');
const { assignedScope } = require('../utils/leadScope');
const { convertedStatusIds, pageConvertedLast } = require('../utils/convertedLast');
const { assertLeadStatusMutable, assertLeadsAssignmentMutable } = require('../utils/leadStatusLock');
const { applyLeadSearch } = require('../utils/leadSearch');

// Google Ads lead form extensions with a webhook. Leads are kept in their own collection
// (GoogleLead), separate from Meta leads, and have their own list, assignment and status.

const MAX_FIELD_VALUE_LENGTH = 2000;
const MAX_REMARK_LENGTH = 1000;
const MAX_BULK_ASSIGN = 500;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;

const log = (event, details = {}) => console.log(`[GOOGLE_ADS] ${event} ${JSON.stringify(details)}`);
const logError = (event, details = {}) => console.error(`[GOOGLE_ADS] ${event} ${JSON.stringify(details)}`);

const isObjectId = (value) => typeof value === 'string' && mongoose.isValidObjectId(value);
const toStringParam = (value) => (typeof value === 'string' ? value.trim() : '');
const serverError = (res, error, message) => {
  console.error(`[GOOGLE_ADS] ${message}:`, error.message);
  res.status(500).json({ message });
};

// Constant-time comparison so the key cannot be guessed from response timing
const keysMatch = (received, expected) => {
  if (typeof received !== 'string' || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Convert Google's user_column_data into the fields stored on GoogleLead
const normalizeGoogleLead = (payload) => {
  const columns = Array.isArray(payload.user_column_data) ? payload.user_column_data : [];
  const fields = {};

  columns.forEach((column, index) => {
    const value = String((column && column.string_value) || '').slice(0, MAX_FIELD_VALUE_LENGTH);
    // Standard columns use ids such as FULL_NAME; custom questions use their text as the name
    const key =
      String((column && (column.column_id || column.column_name)) || `field_${index + 1}`)
        .trim()
        .replace(/\./g, '_')
        .replace(/^[$_]+/, '') || `field_${index + 1}`;
    fields[key] = value;
  });

  const pick = (...keys) => keys.map((key) => fields[key]).find(Boolean) || '';
  const fullName = pick('FULL_NAME') || [pick('FIRST_NAME'), pick('LAST_NAME')].filter(Boolean).join(' ');

  return {
    fields,
    fullName,
    email: pick('EMAIL'),
    phone: pick('PHONE_NUMBER'),
    searchText: buildSearchText(...Object.values(fields)).slice(0, 2000),
  };
};

// @desc    Receive a lead from a Google Ads lead form webhook
// @route   POST /api/google-leads/webhook
// @access  Public (protected by the webhook key in the payload)
const receiveGoogleAdsLead = async (req, res) => {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  let keyInfo = { key: '', companyId: null };
  try {
    keyInfo = await resolveWebhookKeyFromPayload(String(payload.google_key || ''));
  } catch (error) {
    logError('GOOGLE_ADS_KEY_UNREADABLE', { reason: error.message });
  }

  if (!keyInfo.key || !keyInfo.companyId) {
    logError('GOOGLE_ADS_NOT_CONFIGURED', {});
    return res.status(503).json({ message: 'Google Ads webhook is not configured' });
  }

  const leadId = payload.lead_id !== undefined && payload.lead_id !== null ? String(payload.lead_id).trim() : '';
  if (!leadId) {
    return res.status(400).json({ message: 'lead_id is required' });
  }

  try {
    const normalized = normalizeGoogleLead(payload);
    // Never store the webhook key with the lead
    const { google_key, ...rawData } = payload;

    await GoogleLead.create({
      ...normalized,
      company: keyInfo.companyId,
      externalLeadId: leadId,
      formId: payload.form_id ? String(payload.form_id) : '',
      campaignId: payload.campaign_id ? String(payload.campaign_id) : '',
      adGroupId: payload.adgroup_id ? String(payload.adgroup_id) : '',
      creativeId: payload.creative_id ? String(payload.creative_id) : '',
      gclId: payload.gcl_id ? String(payload.gcl_id) : '',
      isTest: Boolean(payload.is_test),
      rawData,
    });

    log('GOOGLE_ADS_LEAD_STORED', { leadId, isTest: Boolean(payload.is_test) });
    return res.status(200).json({ message: 'Lead received' });
  } catch (error) {
    // Google may retry delivery, so a lead that is already stored counts as success
    if (error && error.code === 11000) {
      log('GOOGLE_ADS_LEAD_DUPLICATE', { leadId });
      return res.status(200).json({ message: 'Lead already received' });
    }
    logError('GOOGLE_ADS_LEAD_FAILED', { leadId, reason: error.name });
    return res.status(500).json({ message: 'Could not store lead' });
  }
};

const serializeLead = (lead) => ({
  _id: lead._id,
  externalLeadId: lead.externalLeadId,
  fullName: lead.fullName,
  email: lead.email,
  phone: lead.phone,
  formName: 'Google Ads lead form',
  campaignName: lead.campaignId ? `Campaign ${lead.campaignId}` : '',
  isTest: lead.isTest,
  fields: lead.fields,
  leadCreatedAt: lead.createdAt,
  createdAt: lead.createdAt,
  assignedTo: lead.assignedTo ? { _id: lead.assignedTo._id, name: lead.assignedTo.name || '' } : null,
  assignedAt: lead.assignedAt,
  isPriority: Boolean(lead.isPriority),
  convertedClient: lead.convertedClient || null,
  convertedClientName: lead.convertedClientName || '',
  convertedAt: lead.convertedAt || null,
  convertedByName: lead.convertedByName || '',
  currentStatus: lead.status
    ? { _id: lead.status._id, name: lead.statusName, color: lead.statusColor }
    : null,
  scheduledAt: lead.scheduledAt || null,
  isReassigned: Boolean(lead.isReassigned),
  reassignedCount: lead.reassignedCount || 0,
  assignmentHistory: (lead.assignmentHistory || []).map((h) => ({ id: h.assignee ? String(h.assignee) : null, name: h.assigneeName || '', assignedAt: h.assignedAt, endedAt: h.endedAt || null, byName: h.byName || '' })),
  logs: (lead.logs || []).map((l) => ({ action: l.action, message: l.message || '', byName: l.byName || '', at: l.at })),
  statusHistory: (lead.statusHistory || []).map((entry) => ({
    statusName: entry.statusName,
    statusColor: entry.statusColor,
    remark: entry.remark,
    scheduledAt: entry.scheduledAt || null,
    rescheduled: Boolean(entry.rescheduled),
    changedAt: entry.changedAt,
  })),
});

// @desc    List Google Ads leads with search, filters and paging
// @route   GET /api/google-leads
// @access  Private (admin, manager)
const listGoogleLeads = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.limit || req.query.pageSize, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const filter = { ...leadCompanyFilter(req.leadsCompanyId), isDeleted: false };

    const search = toStringParam(req.query.search).slice(0, MAX_SEARCH_LENGTH).toLowerCase();
    // one box: answers, assignee, status or a date
    await applyLeadSearch(filter, { companyId: req.leadsCompanyId, search, kind: 'google' });

    const assignedTo = toStringParam(req.query.assignedTo);
    if (assignedTo === 'unassigned') filter.assignedTo = null;
    else if (isObjectId(assignedTo)) filter.assignedTo = assignedTo;

    const statusId = toStringParam(req.query.statusId || req.query.status);
    if (statusId === 'none') filter.status = null;
    else if (isObjectId(statusId)) filter.status = statusId;

    const { priority, invalid: invalidPriority } = readPriorityFilter(req.query.priority);
    if (invalidPriority) return res.status(400).json({ message: 'Invalid filter' });
    if (priority !== null) filter.isPriority = priorityCondition(priority);

    const from = toStringParam(req.query.fromDate || req.query.from);
    const to = toStringParam(req.query.toDate || req.query.to);
    if (from || to) {
      filter.createdAt = {};
      if (from && !Number.isNaN(Date.parse(from))) filter.createdAt.$gte = new Date(from);
      if (to && !Number.isNaN(Date.parse(to))) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
      if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt;
    }
    Object.assign(filter, assignedScope(req)); // staff who may only see their own leads

    // converted ("registered") leads go last
    const convertedIds = await convertedStatusIds(req.leadsCompanyId);
    const [total, leads] = await Promise.all([
      GoogleLead.countDocuments(filter),
      pageConvertedLast(GoogleLead, filter, convertedIds.length ? { status: { $in: convertedIds } } : null, (cond) => GoogleLead.find(cond)
        .sort({ createdAt: -1, _id: -1 })
        .populate('assignedTo', 'name')
        .populate('status', 'name color')
        .select('-rawData'), { skip: (page - 1) * pageSize, limit: pageSize }),
    ]);

    res.json({
      leads: leads.map(serializeLead),
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    });
  } catch (error) {
    serverError(res, error, 'Server error loading Google Ads leads');
  }
};

// @desc    Assign Google Ads leads to a counsellor (counsellorId null = unassign)
// @route   POST /api/google-leads/assign
// @access  Private (admin, manager)
const assignGoogleLeads = async (req, res) => {
  const body = req.body || {};
  const leadIds = Array.isArray(body.leadIds) ? [...new Set(body.leadIds)] : [];
  const counsellorId = (body.counsellorId !== undefined ? body.counsellorId : body.telecallerId) || null;

  if (leadIds.length === 0 || !leadIds.every(isObjectId)) {
    return res.status(400).json({ message: 'Select at least one lead' });
  }
  if (leadIds.length > MAX_BULK_ASSIGN) {
    return res.status(400).json({ message: `You can assign up to ${MAX_BULK_ASSIGN} leads at a time` });
  }
  if (counsellorId && !isObjectId(counsellorId)) {
    return res.status(400).json({ message: 'Invalid counsellor' });
  }

  try {
    // the staff member was checked by the main app (same company, active, may hold leads): req.leadsAssignee
    let counsellor = null;
    if (counsellorId) {
      counsellor = req.leadsAssignee && String(req.leadsAssignee._id) === String(counsellorId) ? req.leadsAssignee : null;
      if (!counsellor) return res.status(404).json({ message: 'Staff member not found, inactive, or not allowed to work on leads' });
    }

    const leads = await GoogleLead.find({
      ...leadCompanyFilter(req.leadsCompanyId),
      ...assignedScope(req),
      _id: { $in: leadIds },
      isDeleted: false,
    }).select('_id assignedTo assignedAt assignmentHistory convertedClient status').populate('assignedTo', 'name email').lean();
    const targetId = counsellor ? String(counsellor._id) : '';
    const toChange = leads.filter((lead) => String(lead.assignedTo?._id || '') !== targetId);
    const lock = await assertLeadsAssignmentMutable(req.leadsCompanyId, toChange);
    if (!lock.ok) return res.status(lock.status).json({ message: lock.message });
    const changeIds = toChange.map((lead) => lead._id);

    await applyLeadAssignments(GoogleLead, leadCompanyFilter(req.leadsCompanyId), toChange, counsellor, req.user); // history, flags and log per lead

    log('GOOGLE_ADS_LEADS_ASSIGNED', { userId: String(req.user._id), counsellorId: targetId || null, count: changeIds.length });

    res.json({
      message: counsellor
        ? `${changeIds.length} lead(s) assigned to ${counsellor.name}`
        : `${changeIds.length} lead(s) unassigned`,
      assigned: changeIds.length,
      unchanged: leads.length - changeIds.length,
      notFound: leadIds.length - leads.length,
    });
  } catch (error) {
    serverError(res, error, 'Server error assigning Google Ads leads');
  }
};

// @desc    Set the status of a Google Ads lead (status from the shared lead-status list)
// @route   PUT /api/google-leads/:id/status
// @access  Private (admin, manager)
const updateGoogleLeadStatus = async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, MAX_REMARK_LENGTH) : '';

  if (!isObjectId(id)) return res.status(400).json({ message: 'Invalid lead' });
  if (!isObjectId(body.statusId)) return res.status(400).json({ message: 'Choose a status' });

  try {
    const status = await MetaLeadStatus.findOne({ ...leadCompanyFilter(req.leadsCompanyId), _id: body.statusId, isActive: true, isDeleted: { $ne: true } }).lean();
    if (!status) return res.status(404).json({ message: 'Status not found' });
    const { scheduledAt, error: dateError } = readScheduledAt(body, status);
    if (dateError) return res.status(400).json({ message: dateError });

    const existing = await GoogleLead.findOne({
      ...leadCompanyFilter(req.leadsCompanyId),
      ...assignedScope(req),
      _id: id,
      isDeleted: false,
    }).select('convertedClient status scheduledAt rescheduledCount').lean();
    if (!existing) return res.status(404).json({ message: 'Lead not found' });
    const lock = await assertLeadStatusMutable(req.leadsCompanyId, existing);
    if (!lock.ok) return res.status(lock.status).json({ message: lock.message });

    const now = new Date();
    const move = rescheduleUpdate(existing, scheduledAt, { statusName: status.name, byName: req.user.name || req.user.email || '', at: now });
    const lead = await GoogleLead.findOneAndUpdate(
      { ...leadCompanyFilter(req.leadsCompanyId), ...assignedScope(req), _id: id, isDeleted: false },
      {
        $set: { status: status._id, statusName: status.name, statusColor: status.color, statusUpdatedAt: now, scheduledAt, ...move.set },
        $push: {
          ...move.push,
          logs: statusLogEntry({ status, scheduledAt, remark, rescheduled: move.rescheduled, byName: req.user.name || req.user.email || '', at: now }),
          statusHistory: {
            status: status._id,
            statusName: status.name,
            statusColor: status.color,
            remark,
            scheduledAt,
            rescheduled: move.rescheduled,
            changedBy: req.user._id,
            changedAt: now,
          },
        },
      },
      { new: true }
    ).lean();

    if (!lead) return res.status(404).json({ message: 'Lead not found' });
    res.json({ message: 'Status updated', statusName: status.name });
  } catch (error) {
    serverError(res, error, 'Server error updating Google Ads lead status');
  }
};

// @desc    Whether any Google Ads lead has come in (used to show or hide the setup panel)
// @route   GET /api/google-leads/status
// @access  Private (admin, manager)
const getGoogleAdsStatus = async (req, res) => {
  try {
    const received = await GoogleLead.exists(leadCompanyFilter(req.leadsCompanyId));
    res.json({ connected: Boolean(received) });
  } catch (error) {
    serverError(res, error, 'Server error loading Google Ads status');
  }
};

module.exports = {
  receiveGoogleAdsLead,
  getGoogleAdsStatus,
  listGoogleLeads,
  assignGoogleLeads,
  updateGoogleLeadStatus,
  normalizeGoogleLead,
  keysMatch,
};

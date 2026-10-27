const mongoose = require('mongoose');
const XLSX = require('xlsx');
const ManualLead = require('../models/ManualLead');
const MetaLeadStatus = require('../models/MetaLeadStatus');
const { buildSearchText } = require('../utils/leadSearchText');
const { readPriorityFilter, priorityCondition } = require('../utils/leadPriority');
const { leadCompanyFilter, companyObjectId } = require('../utils/tenant');
const { assignedScope } = require('../utils/leadScope');
const { FIXED_KEYS, FIELD_TYPE_LABEL, formOf, cleanLeadValues, valueText } = require('../utils/leadForm');
const { convertedStatusIds, pageConvertedLast } = require('../utils/convertedLast');
const { assertLeadStatusMutable, assertLeadsAssignmentMutable } = require('../utils/leadStatusLock');
const { applyLeadSearch } = require('../utils/leadSearch');

// Leads added by hand ("Add lead") or imported from CSV / Excel, on the company's own lead form (Manage Masters →
// Lead form). Mounted in backend/src/routes/leads.routes.js, which checks the Leads permissions and sets
// req.leadsAssignedTo for staff who may only see their own leads.

const MAX_BULK_ASSIGN = 500;
const MAX_IMPORT_ROWS = 5000;
const MAX_REJECTED_SHOWN = 100;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_REMARK_LENGTH = 1000;

const isObjectId = (value) => typeof value === 'string' && mongoose.isValidObjectId(value);
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const scope = (req, extra = {}) => ({ ...leadCompanyFilter(req.leadsCompanyId), ...assignedScope(req), ...extra });
const phoneKeyOf = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);
const fail = (res, error, message) => {
  console.error('[MANUAL_LEADS]', message, error && error.message);
  res.status(500).json({ message });
};

const searchTextOf = (form, values) => buildSearchText(
  values.name, values.phone, values.address,
  ...form.filter((f) => !FIXED_KEYS.includes(f.key)).map((f) => valueText(f, values.fields[f.key])),
).slice(0, 2000);

const serialize = (lead) => ({
  _id: lead._id,
  fullName: lead.fullName,
  phone: lead.phone,
  address: lead.address,
  fields: lead.fields || {},
  source: lead.source,
  createdAt: lead.createdAt,
  leadCreatedAt: lead.createdAt,
  createdByName: lead.createdByName,
  assignedTo: lead.assignedTo && lead.assignedTo._id ? { _id: lead.assignedTo._id, name: lead.assignedTo.name || '' } : null,
  assignedAt: lead.assignedAt,
  isPriority: Boolean(lead.isPriority),
  convertedClient: lead.convertedClient || null,
  convertedClientName: lead.convertedClientName || '',
  convertedAt: lead.convertedAt || null,
  convertedByName: lead.convertedByName || '',
  currentStatus: lead.status ? { _id: lead.status._id || lead.status, name: lead.statusName, color: lead.statusColor } : null,
  statusHistory: (lead.statusHistory || []).map((e) => ({ statusName: e.statusName, statusColor: e.statusColor, remark: e.remark, changedAt: e.changedAt, changedByName: e.changedByName || '' })),
});

/** 400 with the first problem as the message and every problem by field key (the form shows them per field). */
const invalid = (res, errors) => res.status(400).json({ message: Object.values(errors)[0], errors });

// @desc    The company's lead form: Name, Phone, Address, then its own fields
// @route   GET /api/leads/form
const getLeadForm = (req, res) => res.json({ fields: formOf(req.company) });

// @desc    Manual leads, with search, filters and paging
// @route   GET /api/leads/manual
const listManualLeads = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const filter = { ...leadCompanyFilter(req.leadsCompanyId), isDeleted: false };

    const search = text(req.query.search).slice(0, 100).toLowerCase();
    // one box: answers, assignee, status or a date
    await applyLeadSearch(filter, { companyId: req.leadsCompanyId, search, kind: 'manual' });
    const assignedTo = text(req.query.assignedTo);
    if (assignedTo === 'unassigned') filter.assignedTo = null;
    else if (isObjectId(assignedTo)) filter.assignedTo = assignedTo;
    const statusId = text(req.query.statusId);
    if (statusId === 'none') filter.status = null;
    else if (isObjectId(statusId)) filter.status = statusId;
    const source = text(req.query.source);
    if (source === 'manual' || source === 'import') filter.source = source;
    const { priority, invalid: badPriority } = readPriorityFilter(req.query.priority);
    if (badPriority) return res.status(400).json({ message: 'Invalid filter' });
    if (priority !== null) filter.isPriority = priorityCondition(priority);
    const from = text(req.query.from);
    const to = text(req.query.to);
    if ((from && !Number.isNaN(Date.parse(from))) || (to && !Number.isNaN(Date.parse(to)))) {
      filter.createdAt = {};
      if (from && !Number.isNaN(Date.parse(from))) filter.createdAt.$gte = new Date(from);
      if (to && !Number.isNaN(Date.parse(to))) filter.createdAt.$lte = new Date(to);
    }
    Object.assign(filter, assignedScope(req)); // staff who may only see their own leads

    // converted ("registered") leads go last
    const convertedIds = await convertedStatusIds(req.leadsCompanyId);
    const [total, leads] = await Promise.all([
      ManualLead.countDocuments(filter),
      pageConvertedLast(ManualLead, filter, convertedIds.length ? { status: { $in: convertedIds } } : null, (cond) => ManualLead.find(cond).sort({ createdAt: -1, _id: -1 }).populate('assignedTo', 'name'), { skip: (page - 1) * pageSize, limit: pageSize }),
    ]);
    res.json({ leads: leads.map(serialize), total, page, pageSize, totalPages: Math.max(Math.ceil(total / pageSize), 1) });
  } catch (error) {
    fail(res, error, 'Could not load the leads');
  }
};

// @desc    Add one lead on the company's form
// @route   POST /api/leads/manual
const createManualLead = async (req, res) => {
  const form = formOf(req.company);
  const { values, errors } = cleanLeadValues(form, req.body || {});
  if (Object.keys(errors).length) return invalid(res, errors);
  try {
    const phoneKey = phoneKeyOf(values.phone);
    const existing = await ManualLead.findOne({ ...leadCompanyFilter(req.leadsCompanyId), phoneKey, isDeleted: false }).select('fullName').lean();
    if (existing) return res.status(409).json({ message: `A lead with this phone number already exists (${existing.fullName}).`, errors: { phone: 'Already used by another lead' } });
    const now = new Date();
    const lead = await ManualLead.create({
      company: companyObjectId(req.leadsCompanyId),
      source: 'manual',
      fullName: values.name,
      phone: values.phone,
      phoneKey,
      address: values.address || '',
      fields: values.fields,
      searchText: searchTextOf(form, values),
      createdBy: req.user._id,
      createdByName: req.user.name || req.user.email || '',
      // someone who may only see their own leads keeps what they add
      ...(req.leadsAssignedTo ? { assignedTo: req.leadsAssignedTo, assignedAt: now } : {}),
    });
    await lead.populate('assignedTo', 'name');
    res.status(201).json(serialize(lead.toObject()));
  } catch (error) {
    fail(res, error, 'Could not add the lead');
  }
};

// @desc    Change a lead's details (all fields of the form are sent)
// @route   PUT /api/leads/manual/:id
const updateManualLead = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead not found' });
  const form = formOf(req.company);
  const { values, errors } = cleanLeadValues(form, req.body || {});
  if (Object.keys(errors).length) return invalid(res, errors);
  try {
    const phoneKey = phoneKeyOf(values.phone);
    const clash = await ManualLead.findOne({ ...leadCompanyFilter(req.leadsCompanyId), phoneKey, isDeleted: false, _id: { $ne: req.params.id } }).select('fullName').lean();
    if (clash) return res.status(409).json({ message: `Another lead already has this phone number (${clash.fullName}).`, errors: { phone: 'Already used by another lead' } });
    const lead = await ManualLead.findOneAndUpdate(
      scope(req, { _id: req.params.id, isDeleted: false }),
      { $set: { fullName: values.name, phone: values.phone, phoneKey, address: values.address || '', fields: values.fields, searchText: searchTextOf(form, values) } },
      { new: true }
    ).populate('assignedTo', 'name').lean();
    if (!lead) return res.status(404).json({ message: 'Lead not found' });
    res.json(serialize(lead));
  } catch (error) {
    fail(res, error, 'Could not save the lead');
  }
};

// @desc    Set the status of a lead (from the shared lead-status list)
// @route   PUT /api/leads/manual/:id/status
const updateManualLeadStatus = async (req, res) => {
  const body = req.body || {};
  const remark = text(body.remark).slice(0, MAX_REMARK_LENGTH);
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead not found' });
  if (!isObjectId(body.statusId)) return res.status(400).json({ message: 'Choose a status' });
  try {
    const status = await MetaLeadStatus.findOne({ ...leadCompanyFilter(req.leadsCompanyId), _id: body.statusId, isActive: true, isDeleted: { $ne: true } }).lean();
    if (!status) return res.status(404).json({ message: 'Status not found' });
    const existing = await ManualLead.findOne(scope(req, { _id: req.params.id, isDeleted: false })).select('convertedClient status').lean();
    if (!existing) return res.status(404).json({ message: 'Lead not found' });
    const lock = await assertLeadStatusMutable(req.leadsCompanyId, existing);
    if (!lock.ok) return res.status(lock.status).json({ message: lock.message });
    const now = new Date();
    const lead = await ManualLead.findOneAndUpdate(
      scope(req, { _id: req.params.id, isDeleted: false }),
      {
        $set: { status: status._id, statusName: status.name, statusColor: status.color, statusUpdatedAt: now },
        $push: { statusHistory: { status: status._id, statusName: status.name, statusColor: status.color, remark, changedBy: req.user._id, changedByName: req.user.name || req.user.email || '', changedAt: now } },
      },
      { new: true }
    ).populate('assignedTo', 'name').lean();
    if (!lead) return res.status(404).json({ message: 'Lead not found' });
    res.json(serialize(lead));
  } catch (error) {
    fail(res, error, 'Could not update the status');
  }
};

// @desc    Give leads to a staff member (or take them away: counsellorId null)
// @route   POST /api/leads/manual/assign
const assignManualLeads = async (req, res) => {
  const body = req.body || {};
  const leadIds = Array.isArray(body.leadIds) ? [...new Set(body.leadIds)] : [];
  const targetId = body.counsellorId ?? body.telecallerId ?? null;
  if (!leadIds.length || !leadIds.every(isObjectId)) return res.status(400).json({ message: 'Select at least one lead' });
  if (leadIds.length > MAX_BULK_ASSIGN) return res.status(400).json({ message: `You can assign up to ${MAX_BULK_ASSIGN} leads at a time` });
  // the staff member was checked by the main app (same company, active, may hold leads): req.leadsAssignee
  const assignee = targetId ? (req.leadsAssignee && String(req.leadsAssignee._id) === String(targetId) ? req.leadsAssignee : null) : null;
  if (targetId && !assignee) return res.status(404).json({ message: 'Staff member not found, inactive, or not allowed to work on leads' });
  try {
    const leads = await ManualLead.find(scope(req, { _id: { $in: leadIds }, isDeleted: false })).select('_id assignedTo convertedClient status').lean();
    const target = assignee ? String(assignee._id) : '';
    const toChange = leads.filter((l) => String(l.assignedTo || '') !== target);
    const lock = await assertLeadsAssignmentMutable(req.leadsCompanyId, toChange);
    if (!lock.ok) return res.status(lock.status).json({ message: lock.message });
    const change = toChange.map((l) => l._id);
    if (change.length) {
      const where = { ...leadCompanyFilter(req.leadsCompanyId), _id: { $in: change } };
      if (assignee) await ManualLead.updateMany(where, { $set: { assignedTo: assignee._id, assignedAt: new Date() } });
      else await ManualLead.updateMany(where, { $unset: { assignedTo: 1, assignedAt: 1 } });
    }
    res.json({ message: assignee ? `${change.length} lead(s) assigned to ${assignee.name}` : `${change.length} lead(s) unassigned`, assigned: change.length, unchanged: leads.length - change.length, notFound: leadIds.length - leads.length });
  } catch (error) {
    fail(res, error, 'Could not assign the leads');
  }
};

const normalize = (h) => String(h ?? '').trim().toLowerCase().replace(/[\s_\-.]+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
const ALIASES = {
  name: ['name', 'full name', 'customer name', 'client name', 'lead name', 'contact name'],
  phone: ['phone', 'phone number', 'mobile', 'mobile number', 'mobile no', 'contact', 'contact number', 'phone no', 'whatsapp', 'whatsapp number'],
  address: ['address', 'full address', 'location', 'site address'],
};

/** Which spreadsheet column fills which field: a column matches a field's name (any case) or key, or a usual alias. */
function mapColumns(form, headings) {
  const map = {};
  const used = new Set();
  headings.forEach((h, col) => {
    const n = normalize(h);
    if (!n) return;
    const field = form.find((f) => !used.has(f.key) && (normalize(f.label) === n || normalize(f.key) === n || (ALIASES[f.key] || []).includes(n)));
    if (field) {
      map[col] = field.key;
      used.add(field.key);
    }
  });
  return map;
}

// @desc    Add leads in bulk from a CSV or Excel sheet laid out like the template
// @route   POST /api/leads/manual/import   (multipart: file)
const importManualLeads = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Choose a CSV or Excel file' });
  const form = formOf(req.company);
  let rows;
  try {
    const book = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheet = book.Sheets[book.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, blankrows: false });
  } catch {
    return res.status(400).json({ message: 'This file could not be read. Upload the CSV or Excel template.' });
  }
  if (!rows.length) return res.status(400).json({ message: 'The file is empty' });
  const headings = rows[0].map((h) => String(h ?? ''));
  const map = mapColumns(form, headings);
  const mapped = new Set(Object.values(map));
  if (!mapped.has('name') || !mapped.has('phone')) {
    return res.status(400).json({ message: 'The first row must hold the column names, including Name and Phone. Download the template to see the layout.' });
  }
  const body = rows.slice(1).filter((r) => r.some((c) => String(c ?? '').trim()));
  if (body.length > MAX_IMPORT_ROWS) return res.status(400).json({ message: `A file can hold up to ${MAX_IMPORT_ROWS} leads` });

  try {
    const tenant = leadCompanyFilter(req.leadsCompanyId);
    const keys = body.map((r) => {
      const col = Object.keys(map).find((c) => map[c] === 'phone');
      return phoneKeyOf(r[col]);
    }).filter(Boolean);
    const known = new Set((await ManualLead.find({ ...tenant, isDeleted: false, phoneKey: { $in: keys } }).select('phoneKey').lean()).map((l) => l.phoneKey));
    const seen = new Set();
    const rejected = [];
    let duplicates = 0;
    const docs = [];
    const now = new Date();
    body.forEach((row, i) => {
      const input = {};
      Object.entries(map).forEach(([col, key]) => { input[key] = row[col]; });
      const { values, errors } = cleanLeadValues(form, input);
      const line = i + 2; // the spreadsheet's own row number (row 1 holds the headings)
      if (Object.keys(errors).length) return rejected.push({ row: line, message: Object.values(errors).join('; ') });
      const phoneKey = phoneKeyOf(values.phone);
      if (known.has(phoneKey) || seen.has(phoneKey)) {
        duplicates += 1;
        return undefined;
      }
      seen.add(phoneKey);
      docs.push({
        company: companyObjectId(req.leadsCompanyId),
        source: 'import',
        fullName: values.name,
        phone: values.phone,
        phoneKey,
        address: values.address || '',
        fields: values.fields,
        searchText: searchTextOf(form, values),
        createdBy: req.user._id,
        createdByName: req.user.name || req.user.email || '',
        ...(req.leadsAssignedTo ? { assignedTo: req.leadsAssignedTo, assignedAt: now } : {}),
      });
      return undefined;
    });
    if (docs.length) await ManualLead.insertMany(docs, { ordered: false });
    res.status(201).json({
      imported: docs.length,
      duplicates,
      rejected: rejected.slice(0, MAX_REJECTED_SHOWN),
      rejectedCount: rejected.length,
      ignoredColumns: headings.filter((h, col) => String(h).trim() && !map[col]),
      total: body.length,
    });
  } catch (error) {
    fail(res, error, 'Could not import the leads');
  }
};

// @desc    An Excel template laid out like the company's form, with a sheet explaining each column
// @route   GET /api/leads/manual/template
const downloadTemplate = (req, res) => {
  const form = formOf(req.company);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([form.map((f) => f.label)]), 'Leads');
  const guide = [['Column', 'Required', 'What to enter'], ...form.map((f) => [
    f.label,
    f.required ? 'Yes' : 'No',
    [
      FIELD_TYPE_LABEL[f.type],
      f.options?.length ? `one of: ${f.options.join(', ')}${f.type === 'multiselect' ? ' (several separated by commas)' : ''}` : '',
      f.type === 'date' ? 'e.g. 16/10/2026 or 2026-10-16' : '',
      f.type === 'yesno' ? 'Yes or No' : '',
      f.help || '',
    ].filter(Boolean).join(' — '),
  ])];
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(guide), 'How to fill');
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', 'attachment; filename="lead-import-template.xlsx"');
  res.send(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
};

module.exports = { getLeadForm, listManualLeads, createManualLead, updateManualLead, updateManualLeadStatus, assignManualLeads, importManualLeads, downloadTemplate, mapColumns };

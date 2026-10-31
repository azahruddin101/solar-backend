// Working on leads: the owner and staff, by their Leads permissions (constants/permissions.js). Staff see and change
// only the leads assigned to them unless they have "Leads › View all". The lead integrations themselves (Meta / Google
// setup, lead statuses, sync, import) stay owner-only under /api/company.
import { Router } from 'express';
import { ROLES } from '../constants/index.js';
import { hasPermission, permissionOnly, requireRole } from '../middlewares/auth.middleware.js';
import { bindLeadsTenant, leadAssignmentModel, leadHandlers as h, leadModels } from '../integrations/leads.js';
import { Client, User } from '../models/index.js';
import { attachPermissions, effectiveFrom, rolesById } from '../services/permission.service.js';
import multer from 'multer';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';

const router = Router();
const view = permissionOnly('leads', 'view', 'view_all');
const status = permissionOnly('leads', 'change_status');
const update = permissionOnly('leads', 'update');
const assign = permissionOnly('leads', 'assign');
const exportLeads = permissionOnly('leads', 'export');
const create = permissionOnly('leads', 'create');

// CSV / Excel sheets for the manual-lead import, kept in memory (read once, never stored)
const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /\.(csv|xlsx|xls)$/i.test(file.originalname || '')),
});
const readSheet = (req, res, next) => sheetUpload.single('file')(req, res, (error) => {
  if (!error) return next();
  res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'The file must be 5 MB or smaller' : 'Upload a CSV or Excel file' });
});

/** Staff without "View all": every query and change below is limited to the leads assigned to them. */
function scopeToOwnLeads(req, res, next) {
  if (!hasPermission(req.user, 'leads', 'view_all')) req.leadsAssignedTo = req.user._id;
  next();
}

const canHoldLeads = (perms) => perms.includes('leads:view') || perms.includes('leads:view_all');

/** Who leads can be assigned to: active staff of this company whose roles let them work on leads. */
async function leadStaff(company) {
  const [staff, roleMap] = await Promise.all([
    User.find({ company: company._id, role: ROLES.AGENT, active: true }).select('name email staffRoles permissions').sort({ name: 1 }),
    rolesById(company._id),
  ]);
  return staff.filter((u) => canHoldLeads(effectiveFrom(u, roleMap)));
}

/** The staff member named in an assign request must be one who may hold leads; the controller trusts req.leadsAssignee. */
async function resolveAssignee(req, res, next) {
  const id = req.body?.counsellorId ?? req.body?.telecallerId ?? null;
  if (!id) return next(); // unassigning
  const user = await User.findOne({ _id: String(id), company: req.company._id, role: ROLES.AGENT, active: true }).catch(() => null);
  if (!user || !canHoldLeads((await attachPermissions(user)).effectivePermissions)) {
    return res.status(400).json({ error: 'Leads can only be assigned to an active staff member whose role lets them work on leads.' });
  }
  req.leadsAssignee = user;
  next();
}

router.use(bindLeadsTenant, scopeToOwnLeads);

router.get('/statuses', view, h.statuses);
router.get('/assignees', permissionOnly('leads', 'assign', 'view_all'), async (req, res) => {
  res.json((await leadStaff(req.company)).map((u) => ({ _id: u.id, name: u.name, email: u.email, status: 'active' })));
});
router.get('/export', exportLeads, rateLimit({ name: 'lead-export', windowMs: 60 * 60 * 1000, max: 20 }), h.exportLeads);
router.get('/all', view, h.allList);
router.get('/board', view, h.board); // the Kanban: the same leads, a column per status

// Manual leads: added on the company's own lead form (Manage Masters → Lead form) or imported from a sheet
router.get('/form', view, h.manual.getLeadForm);
router.get('/manual', view, h.manual.listManualLeads);
router.post('/manual', create, h.manual.createManualLead);
router.get('/manual/template', create, h.manual.downloadTemplate);
router.post('/manual/import', create, rateLimit({ name: 'lead-import', windowMs: 10 * 60 * 1000, max: 20 }), readSheet, h.manual.importManualLeads);
router.post('/manual/assign', assign, resolveAssignee, h.manual.assignManualLeads);
router.put('/manual/:id', update, h.manual.updateManualLead);
router.put('/manual/:id/status', status, h.manual.updateManualLeadStatus);
router.put('/manual/:id/priority', update, h.manualPriority);

router.get('/meta', view, h.metaList);
router.get('/meta/filters', view, h.metaFilters);
router.get('/meta/:id/assignments', view, h.metaAssignments);
router.put('/meta/:id/status', status, h.metaStatus);
router.put('/meta/:id/priority', update, h.metaPriority);
router.post('/meta/assign', assign, resolveAssignee, h.metaAssign);

router.get('/google', view, h.googleList);
router.put('/google/:id/status', status, h.googleStatus);
router.put('/google/:id/priority', update, h.googlePriority);
router.post('/google/assign', assign, resolveAssignee, h.googleAssign);

/**
 * Quick assign: give N of the unassigned leads to one staff member (no ticking boxes). The leads waiting longest go
 * first. The chosen leads then go through the source's normal assign handler, so the same checks and history apply.
 */
const QUICK_ASSIGN = {
  meta: { model: leadModels.meta, base: { processingStatus: 'processed' }, order: { leadCreatedAt: 1, _id: 1 }, handler: h.metaAssign },
  google: { model: leadModels.google, base: {}, order: { createdAt: 1, _id: 1 }, handler: h.googleAssign },
  manual: { model: leadModels.manual, base: {}, order: { createdAt: 1, _id: 1 }, handler: h.manual.assignManualLeads },
};
const MAX_QUICK_ASSIGN = 500;
const unassignedFilter = (req, source) => ({
  ...QUICK_ASSIGN[source].base,
  company: req.company._id,
  isDeleted: false,
  assignedTo: null, // no one (missing or cleared)
  // staff who only see their own leads never see unassigned ones
  ...(req.leadsAssignedTo ? { _id: null } : {}),
});
const QUICK_ASSIGN_SOURCES = Object.keys(QUICK_ASSIGN);

/** ?sources=meta,google or body.sources — defaults to all three. */
function quickAssignSources(req) {
  const raw = req.body?.sources ?? req.query?.sources;
  if (raw === undefined || raw === null || raw === '') return QUICK_ASSIGN_SOURCES;
  const list = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => QUICK_ASSIGN_SOURCES.includes(s));
  return list;
}

/** Oldest unassigned leads first, across the chosen sources. */
async function pickUnassignedAcrossSources(req, count, sourceKeys = QUICK_ASSIGN_SOURCES) {
  const entries = [];
  for (const source of sourceKeys) {
    const { model, order } = QUICK_ASSIGN[source];
    const rows = await model.find(unassignedFilter(req, source)).sort(order).select('createdAt leadCreatedAt').lean();
    for (const row of rows) {
      entries.push({ source, id: String(row._id), at: row.leadCreatedAt || row.createdAt });
    }
  }
  entries.sort((a, b) => new Date(a.at) - new Date(b.at) || a.source.localeCompare(b.source));
  return entries.slice(0, count);
}

const runAssignHandler = (handler, req, leadIds) => new Promise((resolve, reject) => {
  const fakeRes = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      if (this.statusCode >= 400) reject(Object.assign(new Error(body.error || body.message || 'Assign failed'), { status: this.statusCode }));
      else resolve(body);
    },
  };
  req.body = { leadIds, counsellorId: String(req.leadsAssignee._id) };
  Promise.resolve(handler(req, fakeRes)).catch(reject);
});

router.get('/all/unassigned-count', assign, async (req, res) => {
  if (req.leadsAssignedTo) return res.json({ unassigned: 0 });
  const sourceKeys = quickAssignSources(req);
  if (!sourceKeys.length) return res.json({ unassigned: 0 });
  const counts = await Promise.all(
    sourceKeys.map((source) => QUICK_ASSIGN[source].model.countDocuments(unassignedFilter(req, source))),
  );
  res.json({ unassigned: counts.reduce((sum, n) => sum + n, 0) });
});
router.post('/all/assign-unassigned', assign, resolveAssignee, async (req, res) => {
  const count = Number(req.body?.count);
  const sourceKeys = quickAssignSources(req);
  if (!sourceKeys.length) return res.status(400).json({ error: 'Choose at least one lead source' });
  if (!req.leadsAssignee) return res.status(400).json({ error: 'Choose the staff member' });
  if (!Number.isInteger(count) || count < 1) return res.status(400).json({ error: 'Enter how many leads to assign (1 or more)' });
  if (count > MAX_QUICK_ASSIGN) return res.status(400).json({ error: `You can assign up to ${MAX_QUICK_ASSIGN} leads at a time` });
  const available = (await Promise.all(
    sourceKeys.map((source) => QUICK_ASSIGN[source].model.countDocuments(unassignedFilter(req, source))),
  )).reduce((sum, n) => sum + n, 0);
  if (count > available) {
    return res.status(400).json({ error: available ? `Only ${available} lead${available === 1 ? ' is' : 's are'} unassigned` : 'There are no unassigned leads in the sources you chose' });
  }
  const picked = await pickUnassignedAcrossSources(req, count, sourceKeys);
  const bySource = { meta: [], google: [], manual: [] };
  picked.forEach((p) => bySource[p.source].push(p.id));
  try {
    for (const source of Object.keys(QUICK_ASSIGN)) {
      const ids = bySource[source];
      if (!ids.length) continue;
      await runAssignHandler(QUICK_ASSIGN[source].handler, req, ids);
    }
    res.json({ assigned: picked.length });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not assign leads' });
  }
});

for (const source of Object.keys(QUICK_ASSIGN)) {
  router.get(`/${source}/unassigned-count`, assign, async (req, res) => {
    res.json({ unassigned: await QUICK_ASSIGN[source].model.countDocuments(unassignedFilter(req, source)) });
  });
  router.post(`/${source}/assign-unassigned`, assign, resolveAssignee, async (req, res, next) => {
    const count = Number(req.body?.count);
    if (!req.leadsAssignee) return res.status(400).json({ error: 'Choose the staff member' });
    if (!Number.isInteger(count) || count < 1) return res.status(400).json({ error: 'Enter how many leads to assign (1 or more)' });
    if (count > MAX_QUICK_ASSIGN) return res.status(400).json({ error: `You can assign up to ${MAX_QUICK_ASSIGN} leads at a time` });
    const { model, order, handler } = QUICK_ASSIGN[source];
    const filter = unassignedFilter(req, source);
    const available = await model.countDocuments(filter);
    if (count > available) return res.status(400).json({ error: available ? `Only ${available} lead${available === 1 ? ' is' : 's are'} unassigned` : 'There are no unassigned leads' });
    const picked = await model.find(filter).sort(order).limit(count).select('_id').lean();
    req.body = { leadIds: picked.map((l) => String(l._id)), counsellorId: String(req.leadsAssignee._id) };
    return handler(req, res, next);
  });
}

/**
 * A lead in the converted status became a client: link the two (the client was just created from the lead's details).
 * The lead must be in the converted status, the client must be this company's, and a lead is converted only once.
 */
router.put('/:source/:id/converted', status, async (req, res) => {
  const Model = ['meta', 'google', 'manual'].includes(req.params.source) ? leadModels[req.params.source] : null;
  if (!Model) return res.status(404).json({ error: 'Not found' });
  const { id } = req.params;
  const clientId = String(req.body?.clientId || '');
  if (!/^[0-9a-f]{24}$/i.test(id)) return res.status(404).json({ error: 'Lead not found' });
  const client = /^[0-9a-f]{24}$/i.test(clientId) ? await Client.findOne({ _id: clientId, company: req.company._id }).select('name').lean() : null;
  if (!client) return res.status(400).json({ error: 'Client not found' });
  const scope = { _id: id, company: req.company._id, isDeleted: { $ne: true }, ...(req.leadsAssignedTo ? { assignedTo: req.leadsAssignedTo } : {}) };
  const lead = await Model.findOne(scope).lean();
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.convertedClient) return res.status(409).json({ error: `This lead was already converted to ${lead.convertedClientName || 'a client'}` });
  // Meta: the current owner's status counts; before anyone owns the lead, the one set on the lead
  let statusId = lead.status || lead.adminStatus || null;
  if (req.params.source === 'meta') {
    const owned = await leadAssignmentModel.findOne({ company: req.company._id, lead: lead._id, isActive: true }).select('currentStatus').lean();
    statusId = owned?.currentStatus || lead.adminStatus || null;
  }
  const converted = statusId && (await leadModels.status.exists({ _id: statusId, company: req.company._id, outcome: 'converted' }));
  if (!converted) return res.status(400).json({ error: 'Set the lead to your converted status first' });
  await Model.updateOne({ _id: lead._id, company: req.company._id }, { $set: { convertedClient: client._id, convertedClientName: client.name, convertedAt: new Date(), convertedByName: req.user.name || req.user.email || '' } });
  res.json({ convertedClient: client._id, convertedClientName: client.name, convertedAt: new Date(), convertedByName: req.user.name || req.user.email || '' });
});

// performance of the people working on leads: the owner's report
const ownerOnly = requireRole(ROLES.COMPANY);
router.get('/reports/telecallers', ownerOnly, async (req, res, next) => {
  req.leadStaffIds = (await leadStaff(req.company)).map((u) => u._id);
  next();
}, h.report);
router.get('/reports/telecallers/:id', ownerOnly, h.reportTasks);

export default router;

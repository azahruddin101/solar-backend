// AMC (Annual Maintenance Contract) templates on the company and scheduled visits on each installation.
import { Company, Design, Project, User } from '../models/index.js';
import { OPEN_DESIGN_STATUS, ROLES } from '../constants/index.js';
import { badRequest, notFound } from '../utils/HttpError.js';
import { objectId } from '../utils/validators.js';
import { cleanRichText } from '../utils/richText.js';
import { notifyAmcAssigned, notifyAmcRequested, notifyAmcUpcoming } from './notification.service.js';

const MAX_TEMPLATES = 20;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function amcKind(raw) {
  return raw === 'optional' ? 'optional' : 'mandatory';
}

/** Whether an AMC is free (price 0). Only a label and a price: it doesn't change how a visit is scheduled or done. */
export function isFreeAmc(t) {
  return !(Number(t?.price) > 0);
}

function parseAmcPrice(raw, label = 'Price') {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${label} must be zero or a positive number`);
  return Math.round(n * 100) / 100;
}

/**
 * Mandatory visits are scheduled on every installation. Optional ones don't exist until somebody asks for one: the
 * client from their portal, or the company on a proposal's behalf (see submitClientAmcRequest / createAmcVisit).
 */
export function applicableAmcTemplates(company) {
  return (company?.amcTemplates || []).filter((t) => amcKind(t.kind) === 'mandatory');
}

function templateDays(t) {
  const days = t?.daysAfterInstallation;
  if (days == null || days === '') return null;
  const n = Number(days);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
}

function visitFromTemplate(t, base) {
  const days = templateDays(t);
  return {
    name: t.name,
    daysAfterInstallation: days,
    description: t.description || '',
    kind: amcKind(t.kind),
    price: parseAmcPrice(t.price ?? 0),
    criteria: (t.criteria || []).map((label) => ({ label, checked: false, note: '' })),
    dueDate: days != null ? dueDateFrom(base, days) : null,
    workflowStatus: 'scheduled',
    status: 'pending',
  };
}

function parseTemplateDays(t, name) {
  const kind = amcKind(t?.kind);
  const days = templateDays(t);
  if (kind === 'mandatory' && days == null) {
    throw badRequest(`AMC “${name}”: days after installation is required for mandatory visits`);
  }
  if (kind === 'optional') return null; // optional visits are dated when they are requested
  if (days != null && (days < 1 || days > 3650)) {
    throw badRequest(`AMC “${name}”: days after installation must be between 1 and 3650`);
  }
  return days;
}

function cleanCriteria(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const label = String(raw ?? '').trim();
    if (!label) continue;
    if (out.length >= 40) throw badRequest('Up to 40 criteria per AMC');
    out.push(label.slice(0, 200));
  }
  return out;
}

/** The company's AMC template list. Replaced as a whole; visits already spawned on installations are unchanged. */
export async function updateAmcTemplates(company, body) {
  if (!Array.isArray(body?.templates)) throw badRequest('Templates are required');
  if (body.templates.length > MAX_TEMPLATES) throw badRequest(`You can have up to ${MAX_TEMPLATES} AMC schedules`);
  company.amcTemplates = body.templates.map((t, i) => {
    const name = String(t?.name ?? '').trim();
    if (!name) throw badRequest(`AMC ${i + 1}: name is required`);
    const days = parseTemplateDays(t, name);
    return {
      name,
      daysAfterInstallation: days,
      kind: amcKind(t?.kind),
      price: parseAmcPrice(t?.price ?? 0, `AMC “${name}” price`),
      description: t?.description ? cleanRichText(t.description) : '',
      criteria: cleanCriteria(t?.criteria),
    };
  });
  company.amcTemplates.sort((a, b) => {
    const da = a.daysAfterInstallation ?? Number.MAX_SAFE_INTEGER;
    const db = b.daysAfterInstallation ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name);
  });
  await company.save();
  // a mandatory AMC added to the schedule applies to installations already finished, too
  for (const project of await Project.find({ company: company._id, status: 'completed' })) await ensureProjectAmc(project, company);
  return company.amcTemplates;
}

export function installationCompletionDate(project) {
  if (project.installationCompletedAt) return new Date(project.installationCompletedAt);
  const done = (project.steps || []).filter((s) => s.status === 'done' && s.completedAt);
  if (!done.length) return null;
  return new Date(Math.max(...done.map((s) => new Date(s.completedAt).getTime())));
}

function dueDateFrom(base, days) {
  const d = new Date(base.getTime() + days * MS_PER_DAY);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Copy company templates onto a completed installation; keeps client-requested visits already on the project. */
export async function spawnAmcVisitsForProject(project, companyOrId, { design } = {}) {
  const company = companyOrId?.amcTemplates ? companyOrId : await Company.findById(companyOrId).select('amcTemplates');
  const templates = applicableAmcTemplates(company);
  if (!templates.length) return project.amcVisits || [];

  const base = installationCompletionDate(project) || new Date();
  if (!project.installationCompletedAt) project.installationCompletedAt = base;

  if (!project.amcVisits) project.amcVisits = [];
  const existing = new Set(project.amcVisits.map((v) => v.name));
  for (const t of templates) {
    if (existing.has(t.name)) continue;
    project.amcVisits.push(visitFromTemplate(t, base));
  }
  if (design) syncDesignAmcRequestsToProject(design, project, company);
  return project.amcVisits;
}

export function amcRequestRow(req) {
  if (!req) return null;
  return {
    id: req.id,
    packageName: req.packageName,
    requestedDate: req.requestedDate,
    note: req.note || '',
    status: req.status,
    requestedAt: req.requestedAt,
    byCompany: req.requestedBy === 'company',
    assignee: req.assignee ? { id: String(req.assignee), name: req.assigneeName || '' } : null,
  };
}

export function packageRowFromTemplate(t, selected, request = null) {
  return {
    name: t.name,
    description: t.description || '',
    daysAfterInstallation: t.daysAfterInstallation,
    kind: amcKind(t.kind),
    price: parseAmcPrice(t.price ?? 0),
    selected: Boolean(selected),
    request: amcRequestRow(request),
  };
}

/** One line in a visit's own log. `user` may be a staff/owner user, or null for the client / the system. */
export function amcLog(visit, user, action, message = '') {
  if (!visit.logs) visit.logs = [];
  visit.logs.push({ action, by: user?._id || null, byName: user?.name || user?.email || (user === null ? 'Client' : 'System'), byRole: user?.role || '', message: String(message || '').trim().slice(0, 1000) });
}

/** The same line on the installation's activity log, so the job's timeline shows AMC events too. */
function projectAmcLog(project, visit, user, action, message = '') {
  if (!project?.logs) return;
  project.logs.push({ action, step: null, stepName: visit.name || '', by: user?._id || null, byName: user?.name || user?.email || 'System', byRole: user?.role || '', message: String(message || '').trim().slice(0, 1000) });
}

/**
 * Put `agent` on the visit. When someone else already held it, that is a reassignment: the earlier person is kept in
 * previousAssignees, reassignedCount goes up and the log says who handed it to whom. Returns 'assigned' | 'reassigned' | null (no change).
 */
export function setVisitAssignee(project, visit, agent, user, at = new Date()) {
  const agentId = agent?._id || agent?.id || null;
  const agentName = agent?.name || agent?.email || agent?.assigneeName || '';
  if (!agentId) return null;
  if (visit.assignee && String(visit.assignee) === String(agentId)) return null;
  const reassigned = Boolean(visit.assignee);
  if (reassigned) {
    visit.previousAssignees.push({ assignee: visit.assignee, assigneeName: visit.assigneeName || '', assignedAt: visit.assignedAt || null, replacedAt: at });
    visit.reassignedCount = (visit.reassignedCount || 0) + 1;
  }
  const was = visit.assigneeName || '';
  visit.assignee = agentId;
  visit.assigneeName = agentName;
  visit.assignedAt = at;
  visit.assignedBy = user?._id || null;
  visit.workflowStatus = 'assigned';
  const action = reassigned ? 'amc_reassigned' : 'amc_assigned';
  const message = reassigned ? `${was || 'Unassigned'} → ${agentName}` : agentName;
  amcLog(visit, user, action, message);
  projectAmcLog(project, visit, user, action, `${visit.name} — ${message}`);
  return action;
}

function startOfDay(d) {
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) throw badRequest('Choose a valid date');
  x.setHours(0, 0, 0, 0);
  return x;
}

function visitFromClientRequest(t, req) {
  const when = startOfDay(req.requestedDate);
  const days = templateDays(t);
  const workflow = req.status === 'assigned' ? 'assigned' : 'requested';
  return {
    name: t.name,
    daysAfterInstallation: days,
    description: t.description || '',
    kind: amcKind(t.kind),
    price: parseAmcPrice(t.price ?? 0),
    criteria: (t.criteria || []).map((label) => ({ label, checked: false, note: '' })),
    dueDate: when,
    clientRequestedDate: when,
    request: req._id,
    requestNote: req.note || '',
    workflowStatus: workflow,
    assignee: req.assignee || null,
    assigneeName: req.assigneeName || '',
    assignedAt: req.assignedAt || null,
    assignedBy: req.assignedBy || null,
    status: 'pending',
  };
}

/** An optional AMC can be requested again and again, one visit per request; a mandatory one is scheduled by the company. */
export const isRepeatableAmc = (t) => amcKind(t?.kind) === 'optional';

/**
 * The installation visit carrying out a booking: the one linked to it, or — for visits made before visits were
 * linked — an unlinked visit of that package (a completed one only for a completed booking, so a new booking never
 * lands on a visit that was already done).
 */
function visitForRequest(project, req) {
  return (project.amcVisits || []).find((v) => v.request && String(v.request) === String(req._id))
    || (project.amcVisits || []).find((v) => !v.request && v.name === req.packageName && (v.status !== 'completed' || req.status === 'completed'));
}

/** The booking a visit carries out (the linked one, else the open booking of that package). */
function requestForVisit(design, visit) {
  const reqs = design?.amcRequests || [];
  if (visit.request) return reqs.find((r) => String(r._id) === String(visit.request)) || null;
  return reqs.find((r) => r.packageName === visit.name && (r.status === 'requested' || r.status === 'assigned')) || null;
}

/** Mirror client AMC requests onto the installation as visit rows (before or after install completion). */
export function syncDesignAmcRequestsToProject(design, project, company, user = null) {
  if (!design?.amcRequests?.length || !project) return;
  const templates = company?.amcTemplates || [];
  for (const req of design.amcRequests) {
    if (req.status === 'cancelled') continue;
    const tmpl = templates.find((t) => t.name === req.packageName);
    if (!tmpl) continue;
    const visit = visitForRequest(project, req);
    if (!visit) {
      project.amcVisits.push(visitFromClientRequest(tmpl, req));
      const added = project.amcVisits[project.amcVisits.length - 1];
      amcLog(added, req.requestedBy === 'company' ? user : null, 'amc_requested', `${tmpl.name} for ${startOfDay(req.requestedDate).toDateString()}${req.note ? ` — ${req.note}` : ''}`);
      if (added.assignee) amcLog(added, user, 'amc_assigned', added.assigneeName || '');
      continue;
    }
    if (!visit.request) visit.request = req._id;
    if (visit.status === 'completed') continue;
    const when = startOfDay(req.requestedDate);
    visit.dueDate = when;
    visit.clientRequestedDate = when;
    visit.requestNote = req.note || '';
    visit.workflowStatus = req.status;
    if (req.assignee && user) setVisitAssignee(project, visit, { _id: req.assignee, name: req.assigneeName || '' }, user, req.assignedAt || new Date());
    else if (req.assignee) { // a read-time sync (no actor): mirror the booking quietly, never as a reassignment
      visit.assignee = req.assignee;
      visit.assigneeName = req.assigneeName || '';
      visit.assignedAt = req.assignedAt;
      visit.assignedBy = req.assignedBy;
    }
  }
}

function templateByName(company, packageName) {
  const name = String(packageName || '').trim();
  const tmpl = (company?.amcTemplates || []).find((t) => t.name === name);
  if (!tmpl) throw badRequest(`“${name || 'Package'}” is not an AMC package on your provider's schedule`);
  return tmpl;
}

/**
 * The client asks for an optional AMC on a preferred date (portal). They can ask as many times as they like — each
 * request becomes its own visit; `requestId` changes the date of one of their own requests instead. Mandatory AMCs
 * are the company's to schedule, so they can't be requested.
 */
export async function submitClientAmcRequest({ company, design, packageName, requestedDate, note, requestId }) {
  if (!clientMayEditAmcOnDesign(design)) throw badRequest('AMC requests cannot be changed for this proposal.');
  const tmpl = templateByName(company, packageName);
  if (!isRepeatableAmc(tmpl)) throw badRequest(`“${tmpl.name}” is part of your maintenance plan — your provider schedules it, there is nothing to request`);
  const when = startOfDay(requestedDate);
  const today = startOfDay(new Date());
  if (when < today) throw badRequest('Choose today or a future date for the visit');

  const trimmedNote = String(note || '').trim().slice(0, 500);
  let req = null;
  if (requestId) {
    req = design.amcRequests.id(objectId(requestId, 'AMC booking'));
    if (!req || req.packageName !== tmpl.name) throw notFound('AMC booking');
    if (req.status === 'cancelled') throw badRequest('This booking was cancelled');
    if (req.requestedBy === 'company') throw badRequest('This visit was scheduled by your provider. Contact them to change it.');
  }
  if (req?.status === 'completed') throw badRequest('This AMC visit is already completed');

  if (!req) {
    design.amcRequests.push({
      packageName: tmpl.name,
      requestedDate: when,
      note: trimmedNote,
      status: 'requested',
      requestedAt: new Date(),
    });
    req = design.amcRequests[design.amcRequests.length - 1];
  } else {
    req.requestedDate = when;
    req.note = trimmedNote;
    if (req.status === 'assigned') {
      // date change keeps assignment; staff sees updated due date
    } else {
      req.status = 'requested';
      req.assignee = undefined;
      req.assigneeName = '';
      req.assignedAt = null;
      req.assignedBy = undefined;
    }
  }

  const isNew = req.status === 'requested' && !req.assignee;
  await design.save();

  const project = await Project.findOne({ company: design.company, design: design._id });
  if (project) {
    syncDesignAmcRequestsToProject(design, project, company);
    await project.save();
  }
  if (isNew) {
    notifyAmcRequested({
      companyId: String(design.company),
      designId: String(design._id),
      clientId: design.client ? String(design.client) : null,
      note: req.note || '',
      designName: design.name,
      packageName: tmpl.name,
      requestedDate: when,
      eventId: `${req.id}:${when.getTime()}`,
    });
  }
  return req;
}

function clientMayEditAmcOnDesign(design) {
  return OPEN_DESIGN_STATUS.includes(design.status) || design.status === 'won';
}

/** Company queue: client AMC requests awaiting assignment or in progress. */
export async function listAmcRequests(company, { status } = {}) {
  const designs = await Design.find({
    company: company._id,
    status: { $ne: 'draft' },
    'amcRequests.0': { $exists: true },
  })
    .select('name status client amcRequests')
    .populate('client', 'name phone')
    .sort({ updatedAt: -1 })
    .lean();

  const projectByDesign = new Map(
    (await Project.find({ company: company._id, design: { $in: designs.map((d) => d._id) } }).select('design _id').lean())
      .map((p) => [String(p.design), String(p._id)]),
  );

  const items = [];
  for (const d of designs) {
    for (const r of d.amcRequests || []) {
      if (r.status === 'completed' || r.status === 'cancelled') continue;
      if (status && status !== 'all' && r.status !== status) continue;
      items.push({
        id: String(r._id),
        designId: String(d._id),
        designName: d.name,
        designStatus: d.status,
        projectId: projectByDesign.get(String(d._id)) || null,
        client: d.client
          ? { id: String(d.client._id), name: d.client.name, phone: d.client.phone || '' }
          : null,
        packageName: r.packageName,
        requestedDate: r.requestedDate,
        note: r.note || '',
        status: r.status,
        requestedAt: r.requestedAt,
        assignee: r.assignee ? { id: String(r.assignee), name: r.assigneeName || '' } : null,
      });
    }
  }
  items.sort((a, b) => new Date(a.requestedDate).getTime() - new Date(b.requestedDate).getTime());
  return { items, total: items.length };
}

export async function assignAmcRequest(company, user, designId, requestId, assigneeId) {
  const design = await Design.findOne({ _id: objectId(designId, 'Proposal'), company: company._id });
  if (!design) throw notFound('Proposal');
  const req = design.amcRequests?.id(objectId(requestId, 'AMC request'));
  if (!req) throw notFound('AMC request');
  if (req.status === 'completed' || req.status === 'cancelled') throw badRequest('This AMC request is already closed');
  const project = await Project.findOne({ company: company._id, design: design._id });
  if (!project) throw badRequest('Start the installation for this proposal first — the assigned staff completes the visit there.');

  const agent = await User.findOne({
    _id: objectId(assigneeId, 'Staff'),
    company: company._id,
    role: ROLES.AGENT,
    active: { $ne: false },
  });
  if (!agent) throw badRequest('Choose an active staff member');

  req.status = 'assigned';
  req.assignee = agent._id;
  req.assigneeName = agent.name || agent.email;
  req.assignedAt = new Date();
  req.assignedBy = user._id;
  await design.save();

  syncDesignAmcRequestsToProject(design, project, company, user);
  await project.save();

  notifyAmcAssigned({
    companyId: String(company._id),
    clientId: String(design.client),
    projectId: String(project._id),
    designId: String(design._id),
    designName: design.name,
    packageName: req.packageName,
    requestedDate: req.requestedDate,
    assigneeId: String(agent._id),
    assigneeName: req.assigneeName,
    actorId: String(user._id),
    eventId: `${req.id}:${agent.id}`,
  });

  return { ok: true, request: amcRequestRow(req) };
}

/** The visit was done: its booking (shown in the client's portal) is completed too. */
export async function markAmcRequestCompleted(designId, visit) {
  const design = await Design.findById(designId).select('amcRequests');
  if (!design) return;
  const req = requestForVisit(design, visit);
  if (!req) return;
  req.status = 'completed';
  await design.save();
}

/**
 * Makes sure a completed installation has a visit for every mandatory AMC on the schedule — including ones added to the
 * schedule after it was finished. Visits it already has are left alone.
 */
export async function ensureProjectAmc(project, company) {
  if (project.status !== 'completed') return project;
  const design = await Design.findById(project.design).select('amcOptionalSelections');
  await spawnAmcVisitsForProject(project, company, { design });
  if (project.isModified()) await project.save();
  return project;
}

export function daysUntilDue(dueDate, now = new Date()) {
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((due - today) / MS_PER_DAY);
}

/** Visits stored on the project, or computed from the company template for display (no DB write). */
export function effectiveAmcVisits(project, company) {
  if (project.amcVisits?.length) return project.amcVisits;
  if (project.status !== 'completed') return [];
  const templates = applicableAmcTemplates(company);
  if (!templates.length) return [];
  const base = installationCompletionDate(project);
  if (!base) return [];
  return templates.map((t) => {
    const days = templateDays(t);
    return {
      name: t.name,
      daysAfterInstallation: days,
      kind: amcKind(t.kind),
      price: parseAmcPrice(t.price ?? 0),
      dueDate: days != null ? dueDateFrom(base, days) : null,
      workflowStatus: 'scheduled',
      status: 'pending',
    };
  });
}

/** Nearest pending AMC first; completed / no-schedule rows last. */
export function sortAmcOverviewItems(items) {
  const tier = (row) => {
    if (row.next) return 0;
    if (row.allComplete) return 1;
    return 2;
  };
  return [...items].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    if (a.next && b.next) {
      const ta = a.next.dueDate ? new Date(a.next.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.next.dueDate ? new Date(b.next.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    }
    return String(b.installationCompletedAt || '').localeCompare(String(a.installationCompletedAt || ''));
  });
}

function dateInInclusiveRange(iso, from, to) {
  if (!from || !to || !iso) return false;
  const d = new Date(iso);
  const start = new Date(from);
  const end = new Date(to);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return d >= start && d <= end;
}

function applyAmcOverviewFilters(items, { amcFrom, amcTo, installedFrom, installedTo, nextAmc, filter } = {}) {
  let out = items;
  if (installedFrom && installedTo) {
    out = out.filter((r) => dateInInclusiveRange(r.installationCompletedAt, installedFrom, installedTo));
  }
  if (amcFrom && amcTo) {
    out = out.filter((r) => r.next && dateInInclusiveRange(r.next.dueDate, amcFrom, amcTo));
  }
  const visitName = nextAmc ? String(nextAmc).trim() : '';
  if (visitName) {
    out = out.filter((r) => r.next?.name === visitName);
  }
  const f = filter && filter !== 'all' ? filter : '';
  if (f) {
    out = out.filter((r) => {
      switch (f) {
        case 'overdue':
          return Boolean(r.next?.overdue);
        case 'upcoming':
          return Boolean(r.next && (r.next.daysLeft == null || !r.next.overdue));
        case 'due_soon':
          return Boolean(r.next && r.next.daysLeft != null && !r.next.overdue && r.next.daysLeft <= 14);
        case 'pending':
          return Boolean(r.next);
        case 'complete':
          return Boolean(r.allComplete);
        case 'no_schedule':
          return !r.hasSchedule;
        default:
          return true;
      }
    });
  }
  return out;
}

export function summarizeNextAmc(visits, now = new Date()) {
  const pending = (visits || []).filter((v) => v.status !== 'completed');
  const total = visits?.length || 0;
  if (!pending.length) {
    return { next: null, allComplete: total > 0, hasSchedule: total > 0, pendingCount: 0 };
  }
  pending.sort((a, b) => {
    const ta = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    const tb = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });
  const v = pending[0];
  const daysLeft = v.dueDate ? daysUntilDue(v.dueDate, now) : null;
  const id = v._id ? String(v._id) : v.id ? String(v.id) : null;
  return {
    next: {
      id,
      name: v.name,
      kind: amcKind(v.kind),
      free: isFreeAmc(v),
      workflowStatus: v.workflowStatus || null,
      assigneeName: v.assigneeName || '',
      dueDate: v.dueDate || null,
      daysLeft,
      overdue: daysLeft != null && daysLeft < 0,
    },
    allComplete: false,
    hasSchedule: true,
    pendingCount: pending.length,
  };
}

/** Completed installations with the next pending AMC and days until due (company-wide or one agent's sites). */
export async function listAmcOverview(company, { agentId, amcFrom, amcTo, installedFrom, installedTo, nextAmc, filter: statusFilter } = {}) {
  const co = company?.amcTemplates ? company : await Company.findById(company._id).select('amcTemplates');
  // staff also see sites where a paid visit is assigned to them before the installation is finished
  const match = agentId
    ? { company: company._id, $or: [{ status: 'completed', 'steps.assignee': agentId }, { 'amcVisits.assignee': agentId }] }
    : { company: company._id, status: 'completed' };
  const rows = await Project.find(match)
    .select('design client installationCompletedAt amcVisits amcOptionalSelections status')
    .populate('design', 'name summary.address')
    .populate('client', 'name phone')
    .sort({ installationCompletedAt: -1 })
    .lean();

  const items = rows.map((p) => {
    const visits = effectiveAmcVisits(p, co);
    const amc = summarizeNextAmc(visits);
    return {
      projectId: String(p._id),
      design: p.design ? { id: String(p.design._id), name: p.design.name, address: p.design.summary?.address || '' } : null,
      client: p.client ? { id: String(p.client._id), name: p.client.name, phone: p.client.phone || '' } : null,
      installationCompletedAt: p.installationCompletedAt,
      ...amc,
    };
  });

  const filtered = applyAmcOverviewFilters(items, { amcFrom, amcTo, installedFrom, installedTo, nextAmc, filter: statusFilter });
  const sorted = sortAmcOverviewItems(filtered);
  const amcVisitNames = (co?.amcTemplates || []).map((t) => t.name).filter(Boolean);

  return { items: sorted, total: sorted.length, totalInstalled: items.length, amcVisitNames };
}

/** Completed installations that still have a pending AMC visit (sidebar badge). */
export async function amcTrackerCount(company) {
  const co = company?.amcTemplates ? company : await Company.findById(company._id).select('amcTemplates');
  if (!co?.amcTemplates?.length) return 0;
  const rows = await Project.find({ company: company._id, status: 'completed' })
    .select('installationCompletedAt amcVisits status')
    .lean();
  let n = 0;
  for (const p of rows) {
    const visits = effectiveAmcVisits(p, co);
    if (summarizeNextAmc(visits).next) n += 1;
  }
  return n;
}

const UPCOMING_FREE_AMC_DAYS = 7;

/** Tell the company owner(s) and the client about visits (free or paid) due within a week. Each visit is announced once. */
export async function remindUpcomingFreeAmc(now = new Date()) {
  const from = startOfDay(now);
  const to = new Date(from.getTime() + (UPCOMING_FREE_AMC_DAYS + 1) * MS_PER_DAY - 1);
  const projects = await Project.find({
    status: 'completed',
    amcVisits: { $elemMatch: { status: 'pending', dueDate: { $gte: from, $lte: to } } },
  })
    .select('company client design amcVisits')
    .populate('design', 'name')
    .lean();
  for (const p of projects) {
    for (const v of p.amcVisits || []) {
      if (v.status !== 'pending' || !v.dueDate) continue;
      const due = new Date(v.dueDate);
      if (due < from || due > to) continue;
      notifyAmcUpcoming({
        companyId: String(p.company),
        clientId: String(p.client),
        projectId: String(p._id),
        designId: p.design?._id ? String(p.design._id) : null,
        designName: p.design?.name || '',
        visitName: v.name,
        dueDate: due,
        assigneeId: v.assignee ? String(v.assignee) : null,
        eventId: String(v._id),
      });
    }
  }
}

/** Checks for upcoming visits at startup and then every few hours; dedupe lives in the notification inbox. */
export function startAmcReminderWorker({ everyMs = 6 * 60 * 60 * 1000 } = {}) {
  const run = () => remindUpcomingFreeAmc().catch((e) => console.error(`[amc] upcoming visit reminders failed: ${e.message}`));
  run();
  setInterval(run, everyMs).unref();
}

function visitRow(project, v, now) {
  const free = isFreeAmc(v);
  return {
    id: String(v._id),
    projectId: String(project._id),
    projectStatus: project.status,
    name: v.name,
    kind: amcKind(v.kind),
    free,
    price: parseAmcPrice(v.price ?? 0),
    description: v.description || '',
    criteria: (v.criteria || []).map((c) => ({ id: String(c._id), label: c.label, checked: Boolean(c.checked), note: c.note || '' })),
    dueDate: v.dueDate || null,
    daysLeft: v.dueDate ? daysUntilDue(v.dueDate, now) : null,
    clientRequestedDate: v.clientRequestedDate || null,
    requestNote: v.requestNote || '',
    booked: amcKind(v.kind) === 'mandatory' || Boolean(v.clientRequestedDate), // a mandatory visit is scheduled by the company; an optional one has the date it was requested for
    assignee: v.assignee ? { id: String(v.assignee), name: v.assigneeName || '' } : null,
    assignedAt: v.assignedAt || null,
    reassigned: (v.reassignedCount || 0) > 0,
    reassignedCount: v.reassignedCount || 0,
    previousAssignees: (v.previousAssignees || []).map((p) => ({ id: p.assignee ? String(p.assignee) : null, name: p.assigneeName || '', assignedAt: p.assignedAt || null, replacedAt: p.replacedAt || null })),
    logs: [...(v.logs || [])].sort((a, b) => new Date(b.at) - new Date(a.at)).map((l) => ({ id: String(l._id), at: l.at, action: l.action, byName: l.byName || '', message: l.message || '' })),
    status: v.status,
    completedAt: v.completedAt || null,
    completedByName: v.completedByName || '',
    completionNote: v.completionNote || '',
    parts: (v.parts || []).map((p) => ({ productName: p.productName, qty: p.qty, unit: p.unit || '', rate: p.rate })),
    partsInvoice: v.partsInvoice ? { id: String(v.partsInvoice), invoiceNo: v.partsInvoiceNo || '' } : null,
    design: project.design ? { id: String(project.design._id), name: project.design.name, address: project.design.summary?.address || '' } : null,
    client: project.client ? { id: String(project.client._id), name: project.client.name, phone: project.client.phone || '' } : null,
    installationCompletedAt: project.installationCompletedAt || null,
  };
}

/**
 * Every AMC visit as one row: free visits scheduled from the installation date and paid visits the client booked.
 * With `agentId`: visits assigned to that staff member, plus unassigned free visits on sites where they hold a step.
 * Company-wide it also lists bookings whose installation has not started (nothing to assign yet).
 */
export async function listAmcVisits(company, { agentId } = {}) {
  const co = company?.amcTemplates ? company : await Company.findById(company._id).select('amcTemplates');
  const match = agentId
    ? { company: company._id, 'amcVisits.assignee': agentId }
    : { company: company._id, $or: [{ status: 'completed' }, { 'amcVisits.0': { $exists: true } }] };
  const projects = await Project.find(match)
    .select('design client status installationCompletedAt amcVisits amcOptionalSelections steps.assignee steps.status steps.completedAt')
    .populate('design', 'name summary.address amcOptionalSelections')
    .populate('client', 'name phone');

  const now = new Date();
  const items = [];
  for (const p of projects) {
    if (p.status === 'completed' && co?.amcTemplates?.length) {
      await spawnAmcVisitsForProject(p, co, { design: p.design }); // tops up mandatory AMCs added after the installation finished
      if (p.isModified()) await p.save();
    }
    for (const v of p.amcVisits || []) {
      if (agentId && !(v.assignee && String(v.assignee) === String(agentId))) continue; // staff see the visits assigned to them
      items.push(visitRow(p, v, now));
    }
  }

  if (!agentId) {
    const designs = await Design.find({ company: company._id, status: { $ne: 'draft' }, 'amcRequests.0': { $exists: true } })
      .select('name summary.address client amcRequests')
      .populate('client', 'name phone')
      .lean();
    const started = new Set((await Project.find({ company: company._id, design: { $in: designs.map((d) => d._id) } }).select('design').lean())
      .map((p) => String(p.design)));
    for (const d of designs) {
      if (started.has(String(d._id))) continue;
      for (const r of d.amcRequests || []) {
        if (r.status !== 'requested') continue;
        items.push({
          id: `request:${r._id}`,
          projectId: null,
          projectStatus: null,
          name: r.packageName,
          kind: 'optional',
          free: false,
          price: 0,
          criteria: [],
          dueDate: r.requestedDate,
          daysLeft: daysUntilDue(r.requestedDate, now),
          clientRequestedDate: r.requestedDate,
          requestNote: r.note || '',
          booked: true,
          needsInstallation: true,
          assignee: null,
          status: 'pending',
          design: { id: String(d._id), name: d.name, address: d.summary?.address || '' },
          client: d.client ? { id: String(d.client._id), name: d.client.name, phone: d.client.phone || '' } : null,
        });
      }
    }
  }

  items.sort((a, b) => {
    if ((a.status === 'completed') !== (b.status === 'completed')) return a.status === 'completed' ? 1 : -1;
    if (a.status === 'completed') return new Date(b.completedAt || 0) - new Date(a.completedAt || 0);
    const ta = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    const tb = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });
  // every AMC on the company's schedule, so a newly created one can be filtered on before it has any visit
  return { items, total: items.length, amcNames: (co?.amcTemplates || []).map((t) => t.name).filter(Boolean), amcTemplates: (co?.amcTemplates || []).map((t) => ({ name: t.name, kind: amcKind(t.kind) })) };
}

/** Assign (or reassign) staff to one visit. Staff mark it completed once they have done it. */
export async function assignAmcVisit(company, user, projectId, visitId, assigneeId) {
  const project = await Project.findOne({ _id: objectId(projectId, 'Installation'), company: company._id });
  if (!project) throw notFound('Installation');
  const visit = project.amcVisits?.id(objectId(visitId, 'AMC visit'));
  if (!visit) throw notFound('AMC visit');
  if (visit.status === 'completed') throw badRequest('This AMC visit is already completed');
  if (amcKind(visit.kind) === 'optional' && !visit.clientRequestedDate) throw badRequest('This visit has no date yet');

  const agent = await User.findOne({
    _id: objectId(assigneeId, 'Staff'),
    company: company._id,
    role: ROLES.AGENT,
    active: { $ne: false },
  });
  if (!agent) throw badRequest('Choose an active staff member');

  setVisitAssignee(project, visit, agent, user);
  await project.save();

  // keep the client's booking (shown in their portal) in step with the visit
  const design = await Design.findById(project.design).select('name client amcRequests');
  const req = requestForVisit(design, visit);
  if (req && (req.status === 'requested' || req.status === 'assigned')) {
    req.status = 'assigned';
    req.assignee = agent._id;
    req.assigneeName = visit.assigneeName;
    req.assignedAt = visit.assignedAt;
    req.assignedBy = user._id;
    await design.save();
  }

  notifyAmcAssigned({
    companyId: String(company._id),
    clientId: String(project.client),
    projectId: String(project._id),
    designId: String(project.design),
    designName: design?.name || '',
    packageName: visit.name,
    requestedDate: visit.dueDate || visit.clientRequestedDate,
    assigneeId: String(agent._id),
    assigneeName: visit.assigneeName,
    actorId: String(user._id),
    eventId: `${visit.id}:${agent.id}`,
  });
  return { ok: true };
}


/**
 * The company adds an AMC visit to an installation, e.g. an optional one the client asked for by phone. An optional AMC
 * becomes a request on the proposal (shown to the client like one they raised themselves); a mandatory AMC that this
 * installation doesn't have yet is added directly. Staff can be assigned in the same step.
 */
export async function createAmcVisit(company, user, projectId, { name, date, note, assigneeId }) {
  const project = await Project.findOne({ _id: objectId(projectId, 'Installation'), company: company._id });
  if (!project) throw notFound('Installation');
  const design = await Design.findOne({ _id: project.design, company: company._id });
  if (!design) throw notFound('Proposal');
  const tmpl = templateByName(company, name);
  const when = startOfDay(date);
  const trimmedNote = String(note || '').trim().slice(0, 500);

  let visit;
  if (amcKind(tmpl.kind) === 'mandatory') {
    if ((project.amcVisits || []).some((v) => v.name === tmpl.name)) throw badRequest(`“${tmpl.name}” is already on this installation`);
    project.amcVisits.push({ ...visitFromTemplate(tmpl, when), dueDate: when, requestNote: trimmedNote });
    visit = project.amcVisits[project.amcVisits.length - 1];
    amcLog(visit, user, 'amc_added', `${tmpl.name} for ${when.toDateString()}${trimmedNote ? ` — ${trimmedNote}` : ''}`);
    await project.save();
  } else {
    design.amcRequests.push({ packageName: tmpl.name, requestedDate: when, note: trimmedNote, status: 'requested', requestedAt: new Date(), requestedBy: 'company' });
    const req = design.amcRequests[design.amcRequests.length - 1];
    await design.save();
    syncDesignAmcRequestsToProject(design, project, company, user);
    await project.save();
    visit = project.amcVisits.find((v) => v.request && String(v.request) === String(req._id));
  }
  if (assigneeId) await assignAmcVisit(company, user, project.id, visit.id, assigneeId);
  return { ok: true, visitId: visit.id };
}

// Installation projects: the company's steps for one accepted design, who does each step, and a log of
// everything that happened. The company owner manages the whole project; agents work on their own steps.
import { ROLES, STEP_STATUS } from '../constants/index.js';
import { hasPermission } from '../middlewares/auth.middleware.js';
import { Client, Company, Design, Invoice, Product, Project, User } from '../models/index.js';
import { resolveAgentRole, stepPriority } from './company.service.js';
import { notifyAmcCompleted, notifyStepAssigned, notifyStepStatusChange } from './notification.service.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/HttpError.js';
import { dateRangeOnField } from '../utils/listFilters.js';
import { parsePagination, toApiJSON, toApiJSONList } from '../utils/lean.js';
import { pick } from '../utils/pick.js';
import { objectId } from '../utils/validators.js';
import { deductStock, inTransaction } from './stock.service.js';
import { billingService } from './billing.service.js';
import {
  ensureProjectAmc,
  installationCompletionDate,
  markAmcRequestCompleted,
  spawnAmcVisitsForProject,
  syncDesignAmcRequestsToProject,
} from './amc.service.js';

const MAX_STEPS = 30;
const AGENT_FIELDS = 'name email phone jobTitle roles photo active';

/* ───────────── helpers ───────────── */

function logDetails(raw) {
  if (raw && typeof raw === 'object') {
    return {
      message: String(raw.message ?? raw.note ?? '').trim().slice(0, 1000),
      lat: raw.lat != null && raw.lat !== '' ? Number(raw.lat) : null,
      lng: raw.lng != null && raw.lng !== '' ? Number(raw.lng) : null,
      imageUrl: raw.imageUrl ? String(raw.imageUrl).trim().slice(0, 300) : '',
    };
  }
  return { message: String(raw || '').trim().slice(0, 1000), lat: null, lng: null, imageUrl: '' };
}

function log(project, user, action, step = null, details = '') {
  const d = logDetails(details);
  project.logs.push({
    action,
    step: step?._id || null,
    stepName: step?.name || '',
    by: user._id,
    byName: user.name || user.email,
    byRole: user.role,
    message: d.message,
    lat: d.lat,
    lng: d.lng,
    imageUrl: d.imageUrl,
  });
}

function requireCoords(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || la < -90 || la > 90) throw badRequest('Current latitude is required');
  if (!Number.isFinite(ln) || ln < -180 || ln > 180) throw badRequest('Current longitude is required');
  return { lat: la, lng: ln };
}

/** Owners see the client's full contact and the design's value; agents only what they need on site. */
function populate(query, role) {
  const owner = role === ROLES.COMPANY;
  return query
    .populate('design', owner ? 'name status summary' : 'name summary.address summary.kwp summary.panels')
    .populate('client', owner ? 'name email phone address' : 'name phone address')
    .populate('steps.assignee', AGENT_FIELDS)
    .populate('amcVisits.assignee', AGENT_FIELDS);
}

function agentHasRole(agent, role) {
  if (!role) return true;
  const roles = Array.isArray(agent.roles) && agent.roles.length ? agent.roles : agent.jobTitle ? [agent.jobTitle] : [];
  const key = role.toLowerCase();
  return roles.some((r) => String(r).toLowerCase() === key);
}

async function ownAgent(company, id, requiredRole = '') {
  if (!id) return null;
  const agent = await User.findOne({ _id: objectId(id, 'Agent'), company: company._id, role: ROLES.AGENT });
  if (!agent) throw badRequest('Choose one of your agents');
  if (requiredRole && !agentHasRole(agent, requiredRole)) {
    throw badRequest(`This step is for “${requiredRole}”. Choose an agent with that role.`);
  }
  return agent;
}

/** Open installation steps (pending or in progress) per agent, across active projects. */
async function openStepCountsByAgent(companyId) {
  const counts = await Project.aggregate([
    { $match: { company: companyId, status: 'active' } },
    { $unwind: '$steps' },
    { $match: { 'steps.assignee': { $ne: null }, 'steps.status': { $ne: 'done' } } },
    { $group: { _id: '$steps.assignee', n: { $sum: 1 } } },
  ]);
  return new Map(counts.map((c) => [String(c._id), c.n]));
}

async function activeAgentsForRole(company, stepRole) {
  const agents = await User.find({ company: company._id, role: ROLES.AGENT, active: true }).sort({ createdAt: 1 });
  if (!stepRole) return [];
  return agents.filter((a) => agentHasRole(a, stepRole));
}

/** Pick the active agent with this role who has the fewest open steps. */
async function pickAgentForRole(company, stepRole, loadAdjust = null) {
  const candidates = await activeAgentsForRole(company, stepRole);
  if (!candidates.length) return null;
  const counts = await openStepCountsByAgent(company._id);
  if (loadAdjust?.agentId) {
    const id = String(loadAdjust.agentId);
    counts.set(id, Math.max(0, (counts.get(id) || 0) + (loadAdjust.delta || 0)));
  }
  candidates.sort((a, b) => {
    const diff = (counts.get(a.id) || 0) - (counts.get(b.id) || 0);
    if (diff !== 0) return diff;
    return String(a._id).localeCompare(String(b._id));
  });
  return candidates[0];
}

/** Assign when the step has a role and no assignee yet. */
async function autoAssignStep(project, step, company, user, { loadAdjust } = {}) {
  if (!step?.role || step.assignee) return false;
  const agent = await pickAgentForRole(company, step.role, loadAdjust);
  if (!agent) return false;
  step.assignee = agent._id;
  log(project, user, 'step_assigned', step, `${agent.name} · auto-assigned`);
  return true;
}

async function autoAssignStepAfter(project, completedStep, company, user) {
  const idx = project.steps.findIndex((s) => s._id.equals(completedStep._id));
  if (idx < 0 || idx >= project.steps.length - 1) return;
  const loadAdjust = completedStep.assignee ? { agentId: completedStep.assignee, delta: -1 } : null;
  await autoAssignStep(project, project.steps[idx + 1], company, user, { loadAdjust });
}

function stepOf(project, stepId) {
  const step = project.steps.id(objectId(stepId, 'Step'));
  if (!step) throw notFound('Step');
  return step;
}

function cleanName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw badRequest('Step name is required');
  return name;
}

/** Returns the transition when the status really changed (the only case worth notifying), else null. */
function setStepStatus(project, step, status, user, details) {
  if (!STEP_STATUS.includes(status)) throw badRequest('Invalid step status');
  if (status === step.status) return null;
  const from = step.status;
  const d = logDetails(details);
  if (status === 'done') {
    const coords = requireCoords(d.lat, d.lng);
    d.lat = coords.lat;
    d.lng = coords.lng;
  } else {
    d.lat = null;
    d.lng = null;
    d.imageUrl = '';
  }
  const reopened = STEP_STATUS.indexOf(status) < STEP_STATUS.indexOf(step.status);
  const now = new Date();
  if (status === 'pending') step.startedAt = null;
  else step.startedAt ||= now;
  step.completedAt = status === 'done' ? now : null;
  step.status = status;
  log(project, user, reopened ? 'step_reopened' : status === 'done' ? 'step_completed' : 'step_started', step, d);
  return { from, to: status, eventId: String(project.logs.at(-1)._id) }; // the new log entry's id is unique per transition
}

/** Push the change once it is saved. Fire-and-forget: a notification failure never fails the status update. */
function announceStepChange(project, step, user, change) {
  if (!change) return;
  notifyStepStatusChange({
    projectId: String(project._id),
    companyId: String(project.company),
    designId: String(project.design),
    stepId: String(step._id),
    stepName: step.name,
    assigneeId: step.assignee ? String(step.assignee) : '',
    actorId: String(user._id),
    ...change,
  });
}

/** Assignments logged since the last save (manual or automatic); read before save(), dispatched after. */
function pendingAssignments(project, user) {
  return project.logs
    .filter((l) => l.isNew && l.action === 'step_assigned' && l.step)
    .map((l) => {
      const step = project.steps.id(l.step);
      return step?.assignee && { projectId: String(project._id), companyId: String(project.company), designId: String(project.design), stepId: String(step._id), stepName: step.name, assigneeId: String(step.assignee), actorId: String(user._id), eventId: String(l._id) };
    })
    .filter(Boolean);
}

/** The project is complete exactly when every step is done. */
async function syncStatus(project, user, company = null) {
  const next = project.steps.length && project.steps.every((s) => s.status === 'done') ? 'completed' : 'active';
  if (next === project.status) return;
  project.status = next;
  log(project, user, next === 'completed' ? 'completed' : 'reopened');
  if (next === 'completed') {
    const completedAt = installationCompletionDate(project) || new Date();
    project.installationCompletedAt = completedAt;
    const co = company || await Company.findById(project.company).select('amcTemplates');
    // logs: the completion is noted on the proposal; amcRequests: bookings the client made before the install
    const designDoc = await Design.findById(project.design).select('amcOptionalSelections amcRequests logs');
    await spawnAmcVisitsForProject(project, co, { design: designDoc });
    if (designDoc) {
      designDoc.logs.push({
        action: 'installation_completed',
        by: user._id,
        byName: user.name || user.email,
        byRole: user.role,
        message: 'All installation steps finished',
      });
      await designDoc.save();
    }
  }
}

async function saveAndPresent(project, user, company = null) {
  await syncStatus(project, user, company);
  const assigned = pendingAssignments(project, user);
  await project.save();
  assigned.forEach(notifyStepAssigned);
  const doc = await Project.findById(project._id);
  await ensureProjectAmc(doc, company || { _id: project.company });
  return populate(Project.findById(project._id), user.role);
}

function addNoteTo(project, user, body) {
  const message = String(body?.message ?? '').trim();
  if (!message) throw badRequest('Write a note first');
  log(project, user, 'note', body?.step ? stepOf(project, body.step) : null, message);
}

/* ───────────── company owner ───────────── */

async function getOwn(company, id) {
  const project = await Project.findOne({ _id: objectId(id, 'Installation'), company: company._id });
  if (!project) throw notFound('Installation');
  return project;
}

/** Lists leave out the logs. Paginated: pass `page`/`limit` (defaults to a single bounded page). */
export async function listProjects(company, { page, limit, from, to } = {}) {
  const filter = { company: company._id };
  const dateMatch = dateRangeOnField('updatedAt', from, to);
  if (dateMatch) Object.assign(filter, dateMatch);
  const { page: p, limit: l, skip } = parsePagination({ page, limit });
  const [items, total] = await Promise.all([
    populate(Project.find(filter).select('-logs').sort({ updatedAt: -1 }).skip(skip).limit(l), ROLES.COMPANY).lean(),
    Project.countDocuments(filter),
  ]);
  return { items: toApiJSONList(items), total, page: p, limit: l };
}

export async function getProject(company, id) {
  const raw = await Project.findOne({ _id: objectId(id, 'Installation'), company: company._id });
  if (!raw) throw notFound('Installation');
  await ensureProjectAmc(raw, company);
  const project = await populate(Project.findById(raw._id), ROLES.COMPANY);
  return project;
}

/** Start the installation of a design: the company's step template is copied, so later template edits don't touch it. */
export async function startProject(company, user, body) {
  const design = await Design.findOne({ _id: objectId(body?.design, 'Design'), company: company._id }).select('-data');
  if (!design) throw notFound('Design');
  if (!company.installationSteps.length) throw badRequest('Set up your installation steps first');
  if (await Project.exists({ design: design._id })) throw conflict('This design already has an installation');

  const project = new Project({
    company: company._id,
    design: design._id,
    client: design.client,
    amcOptionalSelections: [...(design.amcOptionalSelections || [])],
    steps: company.installationSteps.map((s) => ({ name: s.name, description: s.description, role: s.role || '', priority: s.priority })),
  });
  log(project, user, 'started');
  if (project.steps.length) await autoAssignStep(project, project.steps[0], company, user);
  syncDesignAmcRequestsToProject(design, project, company);
  const assigned = pendingAssignments(project, user);
  await project.save();
  assigned.forEach(notifyStepAssigned);
  const designDoc = await Design.findById(design._id);
  if (designDoc) {
    designDoc.logs.push({
      action: 'installation_started',
      by: user._id,
      byName: user.name || user.email,
      byRole: user.role,
      message: `${project.steps.length} steps from company template`,
    });
    await designDoc.save();
  }
  return populate(Project.findById(project._id), user.role);
}

export async function addStep(company, user, id, body) {
  const project = await getOwn(company, id);
  if (project.steps.length >= MAX_STEPS) throw badRequest(`An installation can have up to ${MAX_STEPS} steps`);
  const role = body?.role !== undefined ? resolveAgentRole(company, body.role) : '';
  if (body?.assignee) need(user, 'assign', 'Assign steps');
  const agent = await ownAgent(company, body?.assignee, role);
  project.steps.push({ name: cleanName(body?.name), description: body?.description, role, priority: stepPriority(body?.priority), assignee: agent?._id || null });
  const step = project.steps.at(-1);
  log(project, user, 'step_added', step);
  if (agent) log(project, user, 'step_assigned', step, agent.name);
  return saveAndPresent(project, user, company);
}

const need = (user, action, label) => {
  if (!hasPermission(user, 'tasks', action)) throw forbidden(`You need the “Installations › ${label}” permission. Ask your company admin.`);
};

/**
 * Rename, describe, (re)assign, change status, or move a step up/down. Each kind of change needs its own permission:
 * Edit steps (name, description, role, priority, order), Assign steps (assignee), Update step status (status).
 */
export async function updateStep(company, user, id, stepId, body) {
  const project = await getOwn(company, id);
  const step = stepOf(project, stepId);
  let change = null;
  const edits = (body?.name !== undefined && cleanName(body.name) !== step.name)
    || (body?.description !== undefined && String(body.description ?? '') !== String(step.description ?? ''))
    || (body?.priority !== undefined && stepPriority(body.priority) !== step.priority)
    || (body?.role !== undefined && resolveAgentRole(company, body.role) !== (step.role || ''))
    || body?.move === 'up' || body?.move === 'down';
  if (edits) need(user, 'update', 'Edit steps');
  if (body?.assignee !== undefined && String(body.assignee || '') !== String(step.assignee || '')) need(user, 'assign', 'Assign steps');
  if (body?.status !== undefined) need(user, 'change_status', 'Update step status');

  if (body?.name !== undefined && cleanName(body.name) !== step.name) {
    const before = step.name;
    step.name = cleanName(body.name);
    log(project, user, 'step_renamed', step, `Was “${before}”`);
  }
  Object.assign(step, pick(body, ['description']));
  if (body?.priority !== undefined) step.priority = stepPriority(body.priority);
  if (body?.role !== undefined) step.role = resolveAgentRole(company, body.role);
  const roleForAssign = step.role || '';
  if (body?.assignee !== undefined && String(body.assignee || '') !== String(step.assignee || '')) {
    const agent = await ownAgent(company, body.assignee, roleForAssign);
    step.assignee = agent?._id || null;
    log(project, user, agent ? 'step_assigned' : 'step_unassigned', step, agent?.name);
  }
  if (body?.status !== undefined) {
    const wasDone = step.status === 'done';
    change = setStepStatus(project, step, body.status, user, body);
    if (!wasDone && step.status === 'done') await autoAssignStepAfter(project, step, company, user);
  }
  if (body?.move === 'up' || body?.move === 'down') {
    const from = project.steps.indexOf(step);
    const to = from + (body.move === 'up' ? -1 : 1);
    if (to >= 0 && to < project.steps.length) {
      const steps = [...project.steps];
      steps.splice(to, 0, steps.splice(from, 1)[0]);
      project.steps = steps;
    }
  }
  const saved = await saveAndPresent(project, user, company);
  announceStepChange(project, step, user, change);
  return saved;
}

export async function removeStep(company, user, id, stepId) {
  const project = await getOwn(company, id);
  const step = stepOf(project, stepId);
  if (project.steps.length === 1) throw badRequest('An installation needs at least one step');
  log(project, user, 'step_removed', step);
  step.deleteOne();
  return saveAndPresent(project, user, company);
}

export async function addNote(company, user, id, body) {
  const project = await getOwn(company, id);
  addNoteTo(project, user, body);
  return saveAndPresent(project, user, company);
}

export async function deleteProject(company, id) {
  const project = await getOwn(company, id);
  await project.deleteOne();
}

/* ───────────── agent ───────────── */

async function getAssigned(user, id) {
  const project = await Project.findOne({
    _id: objectId(id, 'Installation'),
    company: user.company,
    $or: [{ 'steps.assignee': user._id }, { 'amcVisits.assignee': user._id }],
  });
  if (!project) throw notFound('Installation');
  return project;
}

/** 404 unless the agent holds a step in this installation (used by every agent-side read/write). */
export const assertAssigned = async (user, id) => (await getAssigned(user, id))._id;

/** Installations where the agent holds at least one step. */
export function listForAgent(user) {
  return populate(
    Project.find({
      company: user.company,
      $or: [{ 'steps.assignee': user._id }, { 'amcVisits.assignee': user._id }],
    }).select('-logs').sort({ updatedAt: -1 }),
    ROLES.AGENT,
  );
}

export async function getForAgent(user, id) {
  const raw = await getAssigned(user, id);
  await ensureProjectAmc(raw, { _id: user.company });
  return populate(Project.findById(raw._id), ROLES.AGENT);
}

/** Agents move only their own steps. */
export async function setStatusAsAgent(user, id, stepId, body) {
  const project = await getAssigned(user, id);
  const step = stepOf(project, stepId);
  if (String(step.assignee) !== user.id) throw forbidden('This step is assigned to someone else');
  const company = { _id: user.company };
  const wasDone = step.status === 'done';
  const change = setStepStatus(project, step, body?.status, user, body);
  if (!wasDone && step.status === 'done') await autoAssignStepAfter(project, step, company, user);
  const saved = await saveAndPresent(project, user, { _id: user.company });
  announceStepChange(project, step, user, change);
  return saved;
}

function visitOf(project, visitId) {
  const visit = project.amcVisits?.id(objectId(visitId, 'AMC visit'));
  if (!visit) throw notFound('AMC visit');
  return visit;
}

function applyAmcCompletion(visit, body, user) {
  if (visit.status === 'completed') throw badRequest('This AMC visit is already completed');
  const criteria = Array.isArray(body?.criteria) ? body.criteria : [];
  for (const row of criteria) {
    const item = visit.criteria.id(objectId(row.id, 'Criterion'));
    if (!item) throw badRequest('Unknown checklist item');
    if (row.checked !== undefined) item.checked = Boolean(row.checked);
    if (row.note !== undefined) item.note = String(row.note || '').trim().slice(0, 300);
  }
  const unchecked = visit.criteria.filter((c) => !c.checked);
  if (unchecked.length) throw badRequest(`Check all criteria before completing (${unchecked.length} remaining)`);
  visit.status = 'completed';
  visit.completedAt = new Date();
  visit.completedBy = user._id;
  visit.completedByName = user.name || user.email;
  visit.completionNote = body?.note ? String(body.note).trim().slice(0, 1000) : '';
}

/** Emails the client, the company and the assigned staff member that a visit was completed. */
function announceAmcCompleted(project, visit, user) {
  notifyAmcCompleted({
    companyId: String(project.company),
    clientId: project.client ? String(project.client) : null,
    projectId: String(project._id),
    designId: project.design ? String(project.design) : null,
    visitName: visit.name,
    completedByName: visit.completedByName || user.name || user.email || '',
    completionNote: visit.completionNote || '',
    assigneeId: visit.assignee ? String(visit.assignee) : null,
    actorId: String(user._id),
    eventId: String(visit._id),
  });
}

export async function completeAmcVisit(company, user, projectId, visitId, body) {
  need(user, 'change_status', 'Complete AMC visits');
  const project = await getOwn(company, projectId);
  await ensureProjectAmc(project, company);
  const visit = visitOf(project, visitId);
  if (project.status !== 'completed' && visit.workflowStatus !== 'assigned') {
    throw badRequest('Assign staff to this AMC visit first, or complete the installation.');
  }
  applyAmcCompletion(visit, body, user);
  log(project, user, 'amc_completed', null, `${visit.name} — all criteria checked`);
  visit.workflowStatus = 'completed';
  await project.save();
  await markAmcRequestCompleted(project.design, visit);
  announceAmcCompleted(project, visit, user);
  return populate(Project.findById(project._id), user.role);
}

export async function completeAmcVisitAsAgent(user, projectId, visitId, body) {
  const project = await getAssigned(user, projectId);
  await ensureProjectAmc(project, { _id: user.company });
  const visit = visitOf(project, visitId);
  if (!visit.assignee || String(visit.assignee) !== user.id) throw forbidden('This AMC visit is not assigned to you');
  applyAmcCompletion(visit, body, user);
  log(project, user, 'amc_completed', null, `${visit.name} — all criteria checked`);
  visit.workflowStatus = 'completed';
  await project.save();
  await markAmcRequestCompleted(project.design, visit);
  announceAmcCompleted(project, visit, user);
  return populate(Project.findById(project._id), ROLES.AGENT);
}

/* ───────────── parts used on an AMC visit ───────────── */

/** What the invoice PDF needs besides the invoice itself: the client it is addressed to and the proposal's name. */
async function amcPartsInvoiceView(project, visit, invoice) {
  const [client, design] = await Promise.all([
    Client.findById(project.client).select('name email phone address gstNumber pan').lean(),
    Design.findById(project.design).select('name').lean(),
  ]);
  return { invoice: toApiJSON(invoice.toObject ? invoice.toObject() : invoice), client: toApiJSON(client), design: toApiJSON(design), visit: { id: visit.id, name: visit.name, parts: visit.parts, partsInvoiceNo: visit.partsInvoiceNo } };
}

/** Bills the parts replaced on a visit to the client as one invoice on the proposal, and records it on the visit. */
async function billAmcParts(company, user, project, visit, body) {
  if (visit.partsInvoice) throw conflict(`The parts for this visit were already invoiced (${visit.partsInvoiceNo})`);
  if (!project.design) throw badRequest('This installation has no proposal to invoice against');
  const invoice = await billingService.createAmcPartsInvoice(company, user, { project, visit, lines: body.lines, withGst: body.withGst !== false });
  visit.partsInvoice = invoice._id;
  visit.partsInvoiceNo = invoice.invoiceNo;
  visit.parts = (invoice.pricing?.lines || []).map((l) => ({ productName: l.name, qty: l.qty, unit: l.unit || '', rate: l.rate }));
  const what = visit.parts.map((p) => `${p.qty} ${p.unit} ${p.productName}`.trim()).join(', ');
  log(project, user, 'amc_parts_invoiced', null, [`${visit.name} — invoice ${invoice.invoiceNo}: ${what}`, body.note].filter(Boolean).join(' — '));
  await project.save();
  return amcPartsInvoiceView(project, visit, invoice);
}

export async function invoiceAmcParts(company, user, projectId, visitId, body) {
  const project = await getOwn(company, projectId);
  return billAmcParts(company, user, project, visitOf(project, visitId), body);
}

/** A visit of an installation the staff member works on, which is assigned to them (their side of AMC parts). */
function assignedVisitOf(user, project, visitId) {
  const visit = visitOf(project, visitId);
  if (!visit.assignee || String(visit.assignee) !== user.id) throw forbidden('This AMC visit is not assigned to you');
  return visit;
}

export async function invoiceAmcPartsAsAgent(user, projectId, visitId, body) {
  const project = await getAssigned(user, projectId);
  const visit = assignedVisitOf(user, project, visitId);
  const company = await Company.findById(user.company);
  return billAmcParts(company, user, project, visit, body);
}

/** The parts invoice of a visit, for viewing or downloading its PDF. */
async function partsInvoiceOf(project, visitId) {
  const visit = visitOf(project, visitId);
  if (!visit.partsInvoice) throw notFound('Parts invoice');
  const invoice = await Invoice.findById(visit.partsInvoice);
  if (!invoice) throw notFound('Parts invoice');
  return { visit, invoice };
}

export async function getAmcPartsInvoice(company, projectId, visitId) {
  const project = await getOwn(company, projectId);
  const { visit, invoice } = await partsInvoiceOf(project, visitId);
  return amcPartsInvoiceView(project, visit, invoice);
}

export async function getAmcPartsInvoiceAsAgent(user, projectId, visitId) {
  const project = await getAssigned(user, projectId);
  assignedVisitOf(user, project, visitId);
  const { visit, invoice } = await partsInvoiceOf(project, visitId);
  return amcPartsInvoiceView(project, visit, invoice);
}

export async function attachAmcPartsInvoicePdf(company, projectId, visitId, pdfName) {
  const project = await getOwn(company, projectId);
  const { invoice } = await partsInvoiceOf(project, visitId);
  return billingService.attachInvoicePdf(company, invoice.id, pdfName);
}

export async function attachAmcPartsInvoicePdfAsAgent(user, projectId, visitId, pdfName) {
  const project = await getAssigned(user, projectId);
  assignedVisitOf(user, project, visitId);
  const { invoice } = await partsInvoiceOf(project, visitId);
  return billingService.attachInvoicePdf({ _id: user.company }, invoice.id, pdfName);
}

export async function saveStepPhoto(company, user, id, stepId, file) {
  const project = await getOwn(company, id);
  stepOf(project, stepId);
  if (!file) throw badRequest('Choose an image to upload');
  return { url: `/uploads/${file.filename}` };
}

export async function saveStepPhotoAsAgent(user, id, stepId, file) {
  const project = await getAssigned(user, id);
  stepOf(project, stepId);
  if (!file) throw badRequest('Choose an image to upload');
  return { url: `/uploads/${file.filename}` };
}

export async function addNoteAsAgent(user, id, body) {
  const project = await getAssigned(user, id);
  addNoteTo(project, user, body);
  return saveAndPresent(project, user);
}

/* ───────────── cascade ───────────── */

export const deleteProjectsOf = (filter) => Project.deleteMany(filter);

/** Client kept for quick filters; re-point it when a design moves to another client. */
export const moveDesignProject = (design) => Project.updateOne({ design: design._id }, { client: design.client }, { timestamps: false });

/** Staff that installation steps can be assigned to: just what the assign dropdown shows. */
export async function listAssignableStaff(company) {
  const staff = await User.find({ company: company._id, role: ROLES.AGENT }).select('name photo active roles jobTitle').sort({ name: 1 }).lean();
  return staff.map((u) => ({ id: String(u._id), name: u.name, photo: u.photo || '', active: u.active !== false, roles: u.roles?.length ? u.roles : u.jobTitle ? [u.jobTitle] : [] }));
}

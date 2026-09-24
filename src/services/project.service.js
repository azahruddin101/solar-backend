// Installation projects: the company's steps for one accepted design, who does each step, and a log of
// everything that happened. The company owner manages the whole project; agents work on their own steps.
import { ROLES, STEP_STATUS } from '../constants/index.js';
import { Design, Project, User } from '../models/index.js';
import { resolveAgentRole } from './company.service.js';
import { notifyStepAssigned, notifyStepStatusChange } from './notification.service.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/HttpError.js';
import { pick } from '../utils/pick.js';
import { objectId } from '../utils/validators.js';

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
    .populate('steps.assignee', AGENT_FIELDS);
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
async function syncStatus(project, user) {
  const next = project.steps.length && project.steps.every((s) => s.status === 'done') ? 'completed' : 'active';
  if (next === project.status) return;
  project.status = next;
  log(project, user, next === 'completed' ? 'completed' : 'reopened');
  if (next === 'completed') {
    const designDoc = await Design.findById(project.design);
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

async function saveAndPresent(project, user) {
  await syncStatus(project, user);
  const assigned = pendingAssignments(project, user);
  await project.save();
  assigned.forEach(notifyStepAssigned);
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

/** Lists leave out the logs. */
export function listProjects(company) {
  return populate(Project.find({ company: company._id }).select('-logs').sort({ updatedAt: -1 }), ROLES.COMPANY);
}

export async function getProject(company, id) {
  const project = await populate(Project.findOne({ _id: objectId(id, 'Installation'), company: company._id }), ROLES.COMPANY);
  if (!project) throw notFound('Installation');
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
    steps: company.installationSteps.map((s) => ({ name: s.name, description: s.description, role: s.role || '' })),
  });
  log(project, user, 'started');
  if (project.steps.length) await autoAssignStep(project, project.steps[0], company, user);
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
  const agent = await ownAgent(company, body?.assignee, role);
  project.steps.push({ name: cleanName(body?.name), description: body?.description, role, assignee: agent?._id || null });
  const step = project.steps.at(-1);
  log(project, user, 'step_added', step);
  if (agent) log(project, user, 'step_assigned', step, agent.name);
  return saveAndPresent(project, user);
}

/** Rename, describe, (re)assign, change status, or move a step up/down. */
export async function updateStep(company, user, id, stepId, body) {
  const project = await getOwn(company, id);
  const step = stepOf(project, stepId);
  let change = null;

  if (body?.name !== undefined && cleanName(body.name) !== step.name) {
    const before = step.name;
    step.name = cleanName(body.name);
    log(project, user, 'step_renamed', step, `Was “${before}”`);
  }
  Object.assign(step, pick(body, ['description']));
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
  const saved = await saveAndPresent(project, user);
  announceStepChange(project, step, user, change);
  return saved;
}

export async function removeStep(company, user, id, stepId) {
  const project = await getOwn(company, id);
  const step = stepOf(project, stepId);
  if (project.steps.length === 1) throw badRequest('An installation needs at least one step');
  log(project, user, 'step_removed', step);
  step.deleteOne();
  return saveAndPresent(project, user);
}

export async function addNote(company, user, id, body) {
  const project = await getOwn(company, id);
  addNoteTo(project, user, body);
  return saveAndPresent(project, user);
}

export async function deleteProject(company, id) {
  await (await getOwn(company, id)).deleteOne();
}

/* ───────────── agent ───────────── */

async function getAssigned(user, id) {
  const project = await Project.findOne({ _id: objectId(id, 'Installation'), company: user.company, 'steps.assignee': user._id });
  if (!project) throw notFound('Installation');
  return project;
}

/** 404 unless the agent holds a step in this installation (used by every agent-side read/write). */
export const assertAssigned = async (user, id) => (await getAssigned(user, id))._id;

/** Installations where the agent holds at least one step. */
export function listForAgent(user) {
  return populate(Project.find({ company: user.company, 'steps.assignee': user._id }).select('-logs').sort({ updatedAt: -1 }), ROLES.AGENT);
}

export async function getForAgent(user, id) {
  return populate(Project.findById((await getAssigned(user, id))._id), ROLES.AGENT);
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
  const saved = await saveAndPresent(project, user);
  announceStepChange(project, step, user, change);
  return saved;
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

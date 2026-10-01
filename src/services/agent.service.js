// Agents: a company's field staff. They sign in and work on the installation steps assigned to them.
import path from 'node:path';
import { ROLES, STAFF_PERMISSIONS } from '../constants/index.js';
import { Company, Project, User } from '../models/index.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import { hashPassword } from '../utils/password.js';
import { pick } from '../utils/pick.js';
import { email as validEmail, objectId, password as validPassword } from '../utils/validators.js';
import { agentRolesList } from './company.service.js';
import { revokeUserSessions } from './session.service.js';
import { deleteFile } from './storage.service.js';

const FIELDS = ['name', 'phone'];
const MAX_ROLES_PER_AGENT = 10;

async function removePhotoFile(photoUrl) {
  const name = path.basename(String(photoUrl || ''));
  if (name.includes('-agent-')) await deleteFile(name);
}

const NO_STATS = { pending: 0, inProgress: 0, open: 0, done7: 0, done30: 0, done90: 0, doneTotal: 0 };
const DAY = 24 * 60 * 60 * 1000;

function agentPayload(doc, stats = NO_STATS) {
  const j = doc.toJSON ? doc.toJSON() : { ...doc };
  const roles = Array.isArray(j.roles) && j.roles.length ? j.roles : j.jobTitle ? [j.jobTitle] : [];
  return { ...j, roles, openSteps: stats.open, stats };
}

/**
 * Workload per agent across all the company's installations: steps they hold right now, and steps they
 * finished in the last 7 / 30 / 90 days (by the step's completion time, credited to its assignee).
 */
async function agentStats(companyId, agentId = null) {
  const now = Date.now();
  const since = (days) => new Date(now - days * DAY);
  const doneIn = (days) => ({ $sum: { $cond: [{ $and: [{ $eq: ['$steps.status', 'done'] }, { $gte: ['$steps.completedAt', since(days)] }] }, 1, 0] } });
  const rows = await Project.aggregate([
    { $match: { company: companyId } },
    { $unwind: '$steps' },
    { $match: { 'steps.assignee': agentId ? agentId : { $ne: null } } },
    {
      $group: {
        _id: '$steps.assignee',
        pending: { $sum: { $cond: [{ $eq: ['$steps.status', 'pending'] }, 1, 0] } },
        inProgress: { $sum: { $cond: [{ $eq: ['$steps.status', 'in_progress'] }, 1, 0] } },
        done7: doneIn(7),
        done30: doneIn(30),
        done90: doneIn(90),
        doneTotal: { $sum: { $cond: [{ $eq: ['$steps.status', 'done'] }, 1, 0] } },
      },
    },
  ]);
  return new Map(rows.map(({ _id, ...s }) => [String(_id), { ...s, open: s.pending + s.inProgress }]));
}

function parseAgentRoles(company, raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw badRequest('Roles must be a list');
  const allowed = new Map(agentRolesList(company).map((r) => [r.toLowerCase(), r]));
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const label = String(item ?? '').trim();
    if (!label) continue;
    const canon = allowed.get(label.toLowerCase());
    if (!canon) throw badRequest(`Choose roles from your company's list (${label} is not defined)`);
    const key = canon.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canon);
  }
  if (out.length > MAX_ROLES_PER_AGENT) throw badRequest(`An agent can have up to ${MAX_ROLES_PER_AGENT} roles`);
  return out;
}

/**
 * Which `<area>:<action>` permissions (beyond their own assigned steps) this staff member may use.
 * Anything not in that exact shape is dropped rather than rejected — a client that still has an older
 * area-only permission cached (e.g. "designs", from before CRUD-level permissions) shouldn't fail the
 * whole save; it's just silently normalised away.
 */
function parsePermissions(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw badRequest('Permissions must be a list');
  const out = [];
  for (const item of raw) {
    const p = String(item ?? '').trim();
    if (p && STAFF_PERMISSIONS.includes(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

export async function getAgent(company, id) {
  const agent = await User.findOne({ _id: objectId(id, 'Agent'), company: company._id, role: ROLES.AGENT });
  if (!agent) throw notFound('Agent');
  return agent;
}

/** Agents with their current workload and recent completions. */
export async function listAgents(company) {
  const [agents, stats] = await Promise.all([
    User.find({ company: company._id, role: ROLES.AGENT }).sort({ createdAt: -1 }),
    agentStats(company._id),
  ]);
  return agents.map((a) => agentPayload(a, stats.get(a.id) || NO_STATS));
}

export async function createAgent(company, body) {
  const email = validEmail(body?.email);
  const plain = validPassword(body?.password);
  if (!String(body?.name ?? '').trim()) throw badRequest('Agent name is required');
  if (await User.exists({ email })) throw conflict('That email is already in use');
  const roles = parseAgentRoles(company, body?.roles ?? []) ?? [];
  const permissions = parsePermissions(body?.permissions ?? []) ?? [];
  const agent = await User.create({
    ...pick(body, FIELDS),
    roles,
    permissions,
    jobTitle: '',
    email,
    passwordHash: await hashPassword(plain),
    role: ROLES.AGENT,
    company: company._id,
  });
  return agentPayload(agent);
}

/** Profile, active flag, sign-in email and (optionally) a new password. */
export async function updateAgent(company, id, body) {
  const agent = await getAgent(company, id);
  Object.assign(agent, pick(body, FIELDS));
  if (body?.name !== undefined && !String(body.name).trim()) throw badRequest('Agent name is required');
  if (typeof body?.active === 'boolean') agent.active = body.active;
  if (body?.roles !== undefined) {
    agent.roles = parseAgentRoles(company, body.roles) ?? [];
    agent.jobTitle = '';
  }
  if (body?.permissions !== undefined) agent.permissions = parsePermissions(body.permissions) ?? [];
  if (body?.email !== undefined) {
    const email = validEmail(body.email);
    if (email !== agent.email && (await User.exists({ email }))) throw conflict('That email is already in use');
    agent.email = email;
  }
  const passwordChanged = Boolean(body?.password);
  if (passwordChanged) {
    agent.passwordHash = await hashPassword(validPassword(body.password));
    agent.tokenVersion = (agent.tokenVersion || 0) + 1; // the agent's existing sign-ins (a lost or stolen phone, say) stop working
  }
  await agent.save();
  if (passwordChanged || agent.active === false) await revokeUserSessions(agent._id);
  return agentPayload(agent, (await agentStats(company._id, agent._id)).get(agent.id) || NO_STATS);
}

/** Their steps become unassigned; the activity logs keep their name. */
export async function saveAgentPhoto(company, id, file) {
  const agent = await getAgent(company, id);
  if (!file) throw badRequest('Choose an image to upload');
  if (agent.photo) await removePhotoFile(agent.photo);
  agent.photo = `/uploads/${file.filename}`;
  await agent.save();
  return agent;
}

export async function deleteAgentPhoto(company, id) {
  const agent = await getAgent(company, id);
  if (agent.photo) {
    await removePhotoFile(agent.photo);
    agent.photo = '';
    await agent.save();
  }
  return agent;
}

export async function deleteAgent(company, id) {
  const agent = await getAgent(company, id);
  if (agent.photo) await removePhotoFile(agent.photo);
  await Promise.all([
    Project.updateMany({ company: company._id, 'steps.assignee': agent._id }, { $set: { 'steps.$[s].assignee': null } }, { arrayFilters: [{ 's.assignee': agent._id }], timestamps: false }),
  ]);
  await agent.deleteOne();
}

/**
 * The whole team at a glance (company Overview): headline numbers, a 30-day completion trend, how the open work is
 * spread over roles and agents, and how far the installations have got. Days are counted in Indian time.
 */
export async function teamAnalytics(company) {
  const since30 = new Date(Date.now() - 30 * DAY);
  const since90 = new Date(Date.now() - 90 * DAY);
  const [agents, stats, trendRows, roleRows, unassigned, projectRows, timing] = await Promise.all([
    User.find({ company: company._id, role: ROLES.AGENT }).sort({ name: 1 }),
    agentStats(company._id),
    Project.aggregate([
      { $match: { company: company._id } },
      { $unwind: '$steps' },
      { $match: { 'steps.status': 'done', 'steps.completedAt': { $gte: since30 } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$steps.completedAt', timezone: 'Asia/Kolkata' } }, n: { $sum: 1 } } },
    ]),
    Project.aggregate([
      { $match: { company: company._id, status: 'active' } },
      { $unwind: '$steps' },
      { $match: { 'steps.status': { $ne: 'done' } } },
      { $group: { _id: { $ifNull: ['$steps.role', ''] }, pending: { $sum: { $cond: [{ $eq: ['$steps.status', 'pending'] }, 1, 0] } }, inProgress: { $sum: { $cond: [{ $eq: ['$steps.status', 'in_progress'] }, 1, 0] } } } },
    ]),
    Project.aggregate([
      { $match: { company: company._id, status: 'active' } },
      { $unwind: '$steps' },
      { $match: { 'steps.status': { $ne: 'done' }, 'steps.assignee': null } },
      { $count: 'n' },
    ]),
    Project.aggregate([
      { $match: { company: company._id } },
      { $group: { _id: '$status', projects: { $sum: 1 }, steps: { $sum: { $size: '$steps' } }, doneSteps: { $sum: { $size: { $filter: { input: '$steps', as: 's', cond: { $eq: ['$$s.status', 'done'] } } } } } } },
    ]),
    Project.aggregate([
      { $match: { company: company._id } },
      { $unwind: '$steps' },
      { $match: { 'steps.status': 'done', 'steps.completedAt': { $gte: since90 }, 'steps.startedAt': { $ne: null } } },
      { $group: { _id: null, avgMs: { $avg: { $subtract: ['$steps.completedAt', '$steps.startedAt'] } } } },
    ]),
  ]);

  // one entry per day for the last 30 days, zeros included, oldest first
  const byDay = new Map(trendRows.map((r) => [r._id, r.n]));
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
  const trend = Array.from({ length: 30 }, (_, i) => {
    const date = fmt.format(new Date(Date.now() - (29 - i) * DAY));
    return { date, count: byDay.get(date) || 0 };
  });

  const rows = agents.map((a) => {
    const st = stats.get(a.id) || NO_STATS;
    return { id: a.id, name: a.name, photo: a.photo || '', active: a.active, roles: Array.isArray(a.roles) && a.roles.length ? a.roles : a.jobTitle ? [a.jobTitle] : [], ...st };
  });
  const sum = (key) => rows.reduce((n, r) => n + (r[key] || 0), 0);
  const inst = (status) => projectRows.find((r) => r._id === status) || { projects: 0, steps: 0, doneSteps: 0 };
  const all = { steps: inst('active').steps + inst('completed').steps, done: inst('active').doneSteps + inst('completed').doneSteps };

  return {
    team: { agents: rows.length, activeAgents: rows.filter((r) => r.active).length },
    totals: { open: sum('open'), pending: sum('pending'), inProgress: sum('inProgress'), done7: sum('done7'), done30: sum('done30'), done90: sum('done90'), doneTotal: sum('doneTotal'), unassignedOpen: unassigned[0]?.n || 0 },
    avgStepHours: timing[0]?.avgMs != null ? Math.round((timing[0].avgMs / 3600000) * 10) / 10 : null,
    trend,
    byRole: roleRows.map((r) => ({ role: r._id || 'No role set', pending: r.pending, inProgress: r.inProgress, open: r.pending + r.inProgress })).sort((a, b) => b.open - a.open),
    installations: { active: inst('active').projects, completed: inst('completed').projects, stepsDone: all.done, stepsTotal: all.steps },
    agents: rows,
  };
}

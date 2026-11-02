import mongoose from 'mongoose';
import { createRequire } from 'node:module';
import { ROLES } from '../constants/index.js';
import { hasBranchOwnerAccess } from '../constants/tenant.js';
import { Client, User, Project } from '../models/index.js';
import { notFound } from '../utils/HttpError.js';
import { leadModels } from '../integrations/leads.js';

const require = createRequire(import.meta.url);
const { leadVisibilityFilter } = require('../../leads-integration/utils/leadAssignment.js');

function permissionsOf(user) {
  return user?.effectivePermissions ?? user?.permissions ?? [];
}

function perm(user, area, action) {
  if (hasBranchOwnerAccess(user)) return true;
  if (user?.role !== ROLES.AGENT) return false;
  return permissionsOf(user).includes(`${area}:${action}`);
}

/** Direct reports in the same branch (includes self when they carry their own leads/steps). */
export async function teamMemberIds(user) {
  if (!user?._id || user.role !== ROLES.AGENT) return [];
  const reports = await User.find({ company: user.company, role: ROLES.AGENT, manager: user._id, active: true }).select('_id').lean();
  const ids = reports.map((r) => r._id);
  ids.push(user._id);
  return ids;
}

export function canViewAllLeads(user) {
  return hasBranchOwnerAccess(user) || perm(user, 'leads', 'view_all');
}

export function canViewTeamLeads(user) {
  return !canViewAllLeads(user) && perm(user, 'leads', 'view_team');
}

export async function resolveLeadAssigneeScope(user) {
  if (canViewAllLeads(user)) return null;
  if (canViewTeamLeads(user)) {
    const ids = await teamMemberIds(user);
    return ids.length === 1 ? ids[0] : { $in: ids };
  }
  return user._id;
}

/** Mongo filter for leads visible to scoped staff (current assignee or assignment history). */
export function leadAssignedFilter(scope) {
  return leadVisibilityFilter(scope);
}

export async function clientIdsForTeam(companyId, memberIds) {
  const teamSet = new Set(memberIds.map(String));
  const [meta, google, manual, projects] = await Promise.all([
    leadModels.meta.find({ company: companyId, assignedTo: { $in: memberIds }, convertedClient: { $ne: null }, isDeleted: { $ne: true } }).select('convertedClient').lean(),
    leadModels.google.find({ company: companyId, assignedTo: { $in: memberIds }, convertedClient: { $ne: null }, isDeleted: { $ne: true } }).select('convertedClient').lean(),
    leadModels.manual.find({ company: companyId, assignedTo: { $in: memberIds }, convertedClient: { $ne: null }, isDeleted: { $ne: true } }).select('convertedClient').lean(),
    Project.find({ company: companyId, $or: [{ 'steps.assignee': { $in: memberIds } }, { 'amcVisits.assignee': { $in: memberIds } }] }).select('client').lean(),
  ]);
  const ids = new Set();
  for (const row of [...meta, ...google, ...manual]) if (row.convertedClient) ids.add(String(row.convertedClient));
  for (const p of projects) if (p.client) ids.add(String(p.client));
  return [...ids].filter(Boolean);
}

export async function resolveClientScopeFilter(user, companyId) {
  if (hasBranchOwnerAccess(user) || perm(user, 'clients', 'view')) return null;
  if (perm(user, 'clients', 'view_team')) {
    const members = await teamMemberIds(user);
    const clientIds = await clientIdsForTeam(companyId, members);
    return clientIds.length ? { _id: { $in: clientIds.map((id) => new mongoose.Types.ObjectId(id)) } } : { _id: null };
  }
  return { _id: null };
}

export async function projectScopeFilter(user, companyId) {
  if (hasBranchOwnerAccess(user) || perm(user, 'tasks', 'view')) return null;
  if (perm(user, 'tasks', 'view_team')) {
    const members = await teamMemberIds(user);
    return {
      $or: [{ 'steps.assignee': { $in: members } }, { 'amcVisits.assignee': { $in: members } }],
    };
  }
  return { _id: null };
}

/**
 * Route guards for one record (used with router.param('id')): someone who may only see their team's clients /
 * installations gets "not found" for any other record, on every route that takes its id - reads and writes alike.
 */
export async function assertClientVisible(user, companyId, clientId) {
  const scope = await resolveClientScopeFilter(user, companyId);
  if (!scope) return;
  // $and, not a spread: the team scope is itself an `_id` condition and must not replace this one
  if (!mongoose.isValidObjectId(clientId) || !(await Client.exists({ $and: [{ _id: clientId, company: companyId }, scope] }))) throw notFound('Client');
}

export async function assertProjectVisible(user, companyId, projectId) {
  const scope = await projectScopeFilter(user, companyId);
  if (!scope) return;
  if (!mongoose.isValidObjectId(projectId) || !(await Project.exists({ $and: [{ _id: projectId, company: companyId }, scope] }))) throw notFound('Installation');
}

/** Whether an agent may open another agent’s overview. */
export async function canViewStaffOverview(viewer, targetAgentId) {
  if (hasBranchOwnerAccess(viewer)) return true;
  if (viewer.role !== ROLES.AGENT) return false;
  if (String(viewer._id) === String(targetAgentId)) return true;
  if (!perm(viewer, 'leads', 'view_team') && !perm(viewer, 'tasks', 'view_team')) return false;
  const report = await User.findOne({ _id: targetAgentId, company: viewer.company, role: ROLES.AGENT }).select('manager').lean();
  return report && String(report.manager) === String(viewer._id);
}

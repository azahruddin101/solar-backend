// Who hears about what. Business code calls a notify* function after the change is saved; delivery goes
// through OneSignal and can never fail the caller.
import { ROLES, STEP_STATUS_LABEL } from '../constants/index.js';
import { env } from '../config/env.js';
import { Design, Notification, User } from '../models/index.js';
import { effectiveFrom, rolesById } from './permission.service.js';
import { isOneSignalConfigured, sendPush } from './onesignal.service.js';
import { emailAmcAssigned, emailAmcCompleted, emailAmcRequested, emailAmcUpcoming } from './amcEmail.service.js';
import { parsePagination, toApiJSONList } from '../utils/lean.js';

/** Save the inbox rows; a duplicate (same event, same user) is silently skipped by the unique index. */
async function record(audiences, entry) {
  const docs = audiences.flatMap((a) => a.userIds.map((user) => ({ ...entry, user, path: a.path })));
  if (!docs.length) return;
  try {
    await Notification.insertMany(docs, { ordered: false });
  } catch (e) {
    if (e.code !== 11000 && !e.writeErrors?.every((w) => w.code === 11000)) console.error(`[notifications] could not save inbox entries: ${e.message}`);
  }
}

/** Send to several audiences (each with its own link); one failure doesn't stop the others. */
async function deliver(groups, payload) {
  for (const { userIds, url } of groups) {
    if (!userIds.length || !isOneSignalConfigured()) continue;
    try {
      await sendPush({ ...payload, userIds, url, idempotencyKey: `${payload.idempotencyKey}:${url}` });
    } catch (e) {
      console.error(`[push] delivery failed (${payload.data?.event}): ${e.message}`);
    }
  }
}

/**
 * A step's status changed (the caller only invokes this for a real transition).
 * Recipients: the step's assignee (→ /agent) and the company owner(s) (→ /dashboard), never the person who made the change.
 */
export function notifyStepStatusChange(change) {
  // Detached on purpose: the status update has already succeeded and must not wait on, or fail because of, OneSignal.
  sendStepStatusChange(change).catch((e) => console.error(`[push] step notification failed: ${e.message}`));
}

async function sendStepStatusChange({ projectId, companyId, designId, stepId, stepName, assigneeId, actorId, from, to, eventId }) {
  const [owners, design] = await Promise.all([
    User.find({ company: companyId, role: ROLES.COMPANY, active: true }).select('_id').lean(),
    Design.findById(designId).select('name').lean(),
  ]);
  const notActor = (id) => String(id) !== actorId;
  const agentIds = assigneeId ? [assigneeId].filter(notActor) : [];
  const ownerIds = owners.map((u) => String(u._id)).filter(notActor);

  const label = STEP_STATUS_LABEL[to] || to;
  const project = design?.name ? ` (${design.name})` : '';
  const audiences = [
    { userIds: ownerIds, path: `/dashboard/installations/${projectId}` },
    { userIds: agentIds, path: `/agent/projects/${projectId}` },
  ];
  const message = {
    title: 'Installation Step Updated',
    body: `${stepName} has been marked as ${label}${project}.`,
    data: { event: 'step_status_changed', installationId: projectId, installationStepId: stepId, status: to, previousStatus: from },
  };

  // Inbox first (independent of push being configured), then the push.
  await record(audiences, { ...message, company: companyId, type: 'step_status_changed', eventKey: `step-status:${eventId}` });
  await deliver(
    audiences.map((a) => ({ userIds: a.userIds, url: `${env.frontendUrl}${a.path}` })),
    { ...message, idempotencyKey: `step-status:${eventId}` },
  );
}

/* ───────────── inbox (read side) ───────────── */

const PAGE = 30;

/** Newest first. Default: `page` + `limit`. Legacy: `before` (ISO cursor) + `limit`. */
export async function listFor(user, { before, page, limit } = {}) {
  const filter = { user: user._id };
  const unread = await Notification.countDocuments({ user: user._id, readAt: null });

  if (before) {
    const take = Math.min(Math.max(Number(limit) || PAGE, 1), 100);
    const cursor = new Date(before);
    if (!Number.isNaN(cursor.getTime())) filter.createdAt = { $lt: cursor };
    const rows = await Notification.find(filter).sort({ createdAt: -1, _id: -1 }).limit(take + 1).lean();
    const hasMore = rows.length > take;
    return { items: toApiJSONList(rows.slice(0, take)), hasMore, unread };
  }

  const { page: p, limit: l, skip } = parsePagination({ page, limit }, { defaultLimit: 10, maxLimit: 50 });
  const [rows, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(l).lean(),
    Notification.countDocuments(filter),
  ]);
  return { items: toApiJSONList(rows), total, page: p, limit: l, unread };
}

export const unreadCount = (user) => Notification.countDocuments({ user: user._id, readAt: null });

export async function markRead(user, id) {
  await Notification.updateOne({ _id: id, user: user._id, readAt: null }, { readAt: new Date() });
}

export async function markAllRead(user) {
  await Notification.updateMany({ user: user._id, readAt: null }, { readAt: new Date() });
}

/** A step was assigned to an agent (manually or automatically). Only the assignee hears about it. */
export function notifyStepAssigned(assignment) {
  sendStepAssigned(assignment).catch((e) => console.error(`[push] assignment notification failed: ${e.message}`));
}

async function sendStepAssigned({ projectId, companyId, designId, stepId, stepName, assigneeId, actorId, eventId }) {
  if (!assigneeId || assigneeId === actorId) return;
  const design = await Design.findById(designId).select('name').lean();
  const audiences = [{ userIds: [assigneeId], path: `/agent/projects/${projectId}` }];
  const message = {
    title: 'New Installation Step Assigned',
    body: `You have been assigned “${stepName}”${design?.name ? ` (${design.name})` : ''}.`,
    data: { event: 'step_assigned', installationId: projectId, installationStepId: stepId },
  };
  await record(audiences, { ...message, company: companyId, type: 'step_assigned', eventKey: `step-assigned:${eventId}` });
  await deliver(audiences.map((a) => ({ userIds: a.userIds, url: `${env.frontendUrl}${a.path}` })), { ...message, idempotencyKey: `step-assigned:${eventId}` });
}

/** The platform admin replied to / changed a ticket: tell the company's owner(s). */
export function notifyTicketUpdate(update) {
  sendTicketUpdate(update).catch((e) => console.error(`[push] ticket notification failed: ${e.message}`));
}

async function sendTicketUpdate({ ticketId, companyId, ref, subject, title, body, eventId }) {
  const owners = await User.find({ company: companyId, role: ROLES.COMPANY, active: true }).select('_id').lean();
  const audiences = [{ userIds: owners.map((u) => String(u._id)), path: `/dashboard/support/${ticketId}` }];
  const message = { title, body: `${ref} · ${subject}: ${body}`.slice(0, 300), data: { event: 'ticket_update', ticketId } };
  await record(audiences, { ...message, company: companyId, type: 'ticket_update', eventKey: `ticket:${eventId}` });
  await deliver(audiences.map((a) => ({ userIds: a.userIds, url: `${env.frontendUrl}${a.path}` })), { ...message, idempotencyKey: `ticket:${eventId}` });
}

/**
 * Client support (company ↔ client). `toTeam`: the client wrote — tell the owner(s) and staff who may view Client
 * support; otherwise the company wrote — tell that client's portal login(s). Never the person who acted.
 */
export function notifyClientTicket(update) {
  sendClientTicket(update).catch((e) => console.error(`[push] client support notification failed: ${e.message}`));
}

async function sendClientTicket({ ticketId, companyId, clientId, ref, subject, title, body, eventId, toTeam, actorId }) {
  const notActor = (id) => String(id) !== actorId;
  let audiences;
  if (toTeam) {
    const [owners, staff, roles] = await Promise.all([
      User.find({ company: companyId, role: ROLES.COMPANY, active: true }).select('_id').lean(),
      User.find({ company: companyId, role: ROLES.AGENT, active: true }).select('_id permissions staffRoles').lean(),
      rolesById(companyId),
    ]);
    const allowedStaff = staff.filter((u) => effectiveFrom(u, roles).includes('helpdesk:view'));
    audiences = [
      { userIds: owners.map((u) => String(u._id)).filter(notActor), path: `/dashboard/client-support/${ticketId}` },
      { userIds: allowedStaff.map((u) => String(u._id)).filter(notActor), path: `/agent/client-support/${ticketId}` },
    ];
  } else {
    const clients = await User.find({ company: companyId, role: ROLES.CLIENT, client: clientId, active: true }).select('_id').lean();
    audiences = [{ userIds: clients.map((u) => String(u._id)).filter(notActor), path: `/portal/support/${ticketId}` }];
  }
  const message = { title, body: `${ref} · ${subject}: ${body}`.slice(0, 300), data: { event: 'client_ticket_update', ticketId } };
  await record(audiences, { ...message, company: companyId, type: 'client_ticket_update', eventKey: `client-ticket:${eventId}` });
  await deliver(audiences.map((a) => ({ userIds: a.userIds, url: `${env.frontendUrl}${a.path}` })), { ...message, idempotencyKey: `client-ticket:${eventId}` });
}

const PROPOSAL_RESPONSE_LABEL = {
  accepted: 'accepted',
  rejected: 'declined',
  changes_requested: 'asked for changes on',
};

/** A client responded to a proposed design — notify the company owner(s). */
export function notifyProposalResponse(payload) {
  sendProposalResponse(payload).catch((e) => console.error(`[push] proposal response notification failed: ${e.message}`));
}

async function sendProposalResponse({ companyId, designId, designName, designType, decision, note, eventId }) {
  const owners = await User.find({ company: companyId, role: ROLES.COMPANY, active: true }).select('_id').lean();
  const ownerIds = owners.map((u) => String(u._id));
  if (!ownerIds.length) return;
  const verb = PROPOSAL_RESPONSE_LABEL[decision] || 'responded to';
  const designPath = designType === 'quick' ? `/proposal/${designId}` : `/design/${designId}/plan`;
  const audiences = [{ userIds: ownerIds, path: designPath }];
  const snippet = note ? `: ${note}` : '';
  const message = {
    title: 'Client responded to a proposal',
    body: `${designName || 'A proposal'} was ${verb}${snippet}`.slice(0, 400),
    data: { event: 'proposal_client_response', designId, decision },
  };
  await record(audiences, { ...message, company: companyId, type: 'proposal_client_response', eventKey: `proposal-response:${eventId}` });
  await deliver(audiences.map((a) => ({ userIds: a.userIds, url: `${env.frontendUrl}${a.path}` })), { ...message, idempotencyKey: `proposal-response:${eventId}` });
}

/** The company sent an updated proposal for the client to review again. */
export function notifyClientProposalReadyForReview(payload) {
  sendClientProposalReadyForReview(payload).catch((e) => console.error(`[push] client review invite failed: ${e.message}`));
}

async function sendClientProposalReadyForReview({ companyId, clientId, designId, designName, message, eventId }) {
  const clientUsers = await User.find({ company: companyId, role: ROLES.CLIENT, client: clientId, active: true }).select('_id').lean();
  const userIds = clientUsers.map((u) => String(u._id));
  if (!userIds.length) return;
  const audiences = [{ userIds, path: `/portal/${designId}` }];
  const snippet = message ? `: ${message}` : '';
  const msg = {
    title: 'Updated proposal ready to review',
    body: `${designName || 'Your proposal'} has been updated${snippet}`.slice(0, 400),
    data: { event: 'proposal_ready_for_review', designId },
  };
  await record(audiences, { ...msg, company: companyId, type: 'proposal_ready_for_review', eventKey: `proposal-review:${eventId}` });
  await deliver(audiences.map((a) => ({ userIds: a.userIds, url: `${env.frontendUrl}${a.path}` })), { ...msg, idempotencyKey: `proposal-review:${eventId}` });
}

/* ───────────── AMC (maintenance visits) ───────────── */

const ownerIdsOf = async (companyId) => (await User.find({ company: companyId, role: ROLES.COMPANY, active: true }).select('_id').lean()).map((u) => String(u._id));
/** Active staff of the company holding `permission` through their roles or own grants (resolved now, so it follows role changes). */
async function staffIdsWith(companyId, permission) {
  const [staff, roles] = await Promise.all([
    User.find({ company: companyId, role: ROLES.AGENT, active: true }).select('_id permissions staffRoles').lean(),
    rolesById(companyId),
  ]);
  return staff.filter((u) => effectiveFrom(u, roles).includes(permission)).map((u) => String(u._id));
}
const clientUserIdsOf = async (companyId, clientId) => (await User.find({ company: companyId, role: ROLES.CLIENT, client: clientId, active: true }).select('_id').lean()).map((u) => String(u._id));
const shortDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

async function sendTo(audiences, message, companyId, type, eventKey) {
  await record(audiences, { ...message, company: companyId, type, eventKey });
  await deliver(audiences.map((a) => ({ userIds: a.userIds, url: `${env.frontendUrl}${a.path}` })), { ...message, idempotencyKey: eventKey });
}

/** A client booked a paid AMC package: the company owner(s) and staff who may assign AMC visits assign someone from the AMC tracker. */
export function notifyAmcRequested(payload) {
  sendAmcRequested(payload).catch((e) => console.error(`[push] AMC request notification failed: ${e.message}`));
  emailAmcRequested(payload).catch((e) => console.error(`[mail] AMC request emails failed: ${e.message}`));
}

async function sendAmcRequested({ companyId, designName, packageName, requestedDate, eventId }) {
  const [ownerIds, assignerIds] = await Promise.all([ownerIdsOf(companyId), staffIdsWith(companyId, 'tasks:assign')]);
  const audiences = [{ userIds: ownerIds, path: '/dashboard/amc' }, { userIds: assignerIds, path: '/agent/amc?scope=all' }];
  const message = {
    title: 'New AMC request',
    body: `${packageName} requested for ${shortDate(requestedDate)}${designName ? ` (${designName})` : ''}. Assign staff to it.`,
    data: { event: 'amc_requested' },
  };
  await sendTo(audiences, message, companyId, 'amc_requested', `amc-requested:${eventId}`);
}

/** Staff were assigned to a client's AMC request: tell the staff member and the client. */
export function notifyAmcAssigned(payload) {
  sendAmcAssigned(payload).catch((e) => console.error(`[push] AMC assignment notification failed: ${e.message}`));
  emailAmcAssigned(payload).catch((e) => console.error(`[mail] AMC assignment emails failed: ${e.message}`));
}

async function sendAmcAssigned({ companyId, clientId, projectId, designName, packageName, requestedDate, assigneeId, assigneeName, actorId, eventId }) {
  const when = shortDate(requestedDate);
  const site = designName ? ` (${designName})` : '';
  const clientIds = await clientUserIdsOf(companyId, clientId);
  const staff = { userIds: assigneeId && assigneeId !== actorId ? [assigneeId] : [], path: `/agent/projects/${projectId}` };
  const client = { userIds: clientIds, path: '/portal/maintenance' };
  await sendTo([staff], {
    title: 'AMC visit assigned to you',
    body: `${packageName} on ${when}${site}.`,
    data: { event: 'amc_assigned', installationId: projectId },
  }, companyId, 'amc_assigned', `amc-assigned:${eventId}`);
  await sendTo([client], {
    title: 'Technician assigned for your AMC visit',
    body: `${assigneeName || 'A technician'} will visit for ${packageName} on ${when}.`,
    data: { event: 'amc_assigned' },
  }, companyId, 'amc_assigned', `amc-assigned-client:${eventId}`);
}

/** A free (included) AMC visit is due soon: no booking needed, just a heads-up for the company and the client. */
export function notifyAmcUpcoming(payload) {
  sendAmcUpcoming(payload).catch((e) => console.error(`[push] upcoming AMC notification failed: ${e.message}`));
  emailAmcUpcoming(payload).catch((e) => console.error(`[mail] upcoming AMC emails failed: ${e.message}`));
}

/** An AMC visit was completed: emails to the client, the company and the assigned staff member (see amcEmail.service.js). */
export function notifyAmcCompleted(payload) {
  emailAmcCompleted(payload).catch((e) => console.error(`[mail] AMC completion emails failed: ${e.message}`));
}

async function sendAmcUpcoming({ companyId, clientId, projectId, designName, visitName, dueDate, eventId }) {
  const [ownerIds, assignerIds, clientIds] = await Promise.all([ownerIdsOf(companyId), staffIdsWith(companyId, 'tasks:assign'), clientUserIdsOf(companyId, clientId)]);
  const when = shortDate(dueDate);
  const site = designName ? ` (${designName})` : '';
  await sendTo([{ userIds: ownerIds, path: `/dashboard/installations/${projectId}` }, { userIds: assignerIds, path: `/agent/installations/${projectId}` }], {
    title: 'Upcoming free AMC visit',
    body: `${visitName} is due on ${when}${site}.`,
    data: { event: 'amc_upcoming', installationId: projectId },
  }, companyId, 'amc_upcoming', `amc-upcoming:${eventId}`);
  await sendTo([{ userIds: clientIds, path: '/portal/maintenance' }], {
    title: 'Your free maintenance visit is coming up',
    body: `${visitName} is scheduled for ${when}${site}. No booking needed — your provider will visit.`,
    data: { event: 'amc_upcoming' },
  }, companyId, 'amc_upcoming', `amc-upcoming:${eventId}`);
}

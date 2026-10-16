// Client support: help requests between a company and its own clients. A client opens one from the client portal;
// the company's owner, or staff with the "Client support" permission, reply and set its status. A company can also
// start a conversation with one of its clients.
//
// Separate from support tickets with the platform (ticket.service.js): another collection, other routes and another
// permission. The platform admin can't reach these, and a client never sees the company's platform tickets.
// Polling-based like the platform tickets: the UI refreshes on demand.
import mongoose from 'mongoose';
import path from 'node:path';
import { CLIENT_TICKET_CATEGORIES, ROLES, TICKET_PRIORITIES, TICKET_STATUS, TICKET_STATUS_LABEL } from '../constants/index.js';
import { PERMISSION_CATALOG } from '../constants/permissions.js';
import { hasPermission } from '../middlewares/auth.middleware.js';
import { Client, ClientTicket } from '../models/index.js';
import { badRequest, forbidden, notFound } from '../utils/HttpError.js';
import { parsePagination, toApiJSON } from '../utils/lean.js';
import { objectId } from '../utils/validators.js';
import { notifyClientTicket } from './notification.service.js';
import { deleteFile } from './storage.service.js';

const MAX_MESSAGES = 1000;
const isClient = (user) => user.role === ROLES.CLIENT;
const isTeam = (user) => user.role === ROLES.COMPANY || user.role === ROLES.AGENT;

/** The company side: the owner, or staff holding this exact Client support action. */
function assertTeam(user, action) {
  if (!isTeam(user) || !hasPermission(user, 'helpdesk', action)) {
    throw forbidden(`You need the “${PERMISSION_CATALOG.helpdesk.label} › ${PERMISSION_CATALOG.helpdesk.actions[action]}” permission. Ask your company admin.`);
  }
}

/** What this person may see: a client only their own requests, the company all of its clients' requests. */
function scopeOf(user) {
  if (isClient(user)) {
    if (!user.client) throw forbidden();
    return { company: user.company, client: user.client };
  }
  assertTeam(user, 'view');
  return { company: user.company };
}

const unreadField = (user) => (isClient(user) ? 'clientUnread' : 'teamUnread');

function audit(ticket, user, action, message = '') {
  ticket.logs.push({ action, by: user._id, byName: user.name || user.email, byRole: user.role, message });
}

async function load(user, id) {
  const ticket = await ClientTicket.findOne({ ...scopeOf(user), _id: objectId(id, 'Request') });
  if (!ticket) throw notFound('Request');
  return ticket;
}

function present(ticket, viewer) {
  const t = ticket.toJSON ? ticket.toJSON() : ticket;
  t.unread = ticket[unreadField(viewer)] || 0;
  delete t.clientUnread;
  delete t.teamUnread;
  return t;
}

function attachmentsOf(files = []) {
  return files.map((f) => ({ url: `/uploads/${f.filename}`, name: String(f.originalname || f.filename).slice(0, 200), mime: f.mimetype, size: f.size }));
}

async function removeUploads(files = []) {
  await Promise.all(files.map((f) => deleteFile(path.basename(f.filename || f.url || ''))));
}

const cleanText = (value, max) => String(value ?? '').trim().slice(0, max);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Match by request id (REQ-ABC123, its 6 characters, or the full id), subject, or — for the company — client name. */
async function searchFilter(user, q) {
  const term = String(q ?? '').trim().slice(0, 100);
  if (!term) return null;
  const code = term.replace(/^req-?/i, '');
  const or = [{ subject: { $regex: escapeRe(term), $options: 'i' } }];
  if (mongoose.isValidObjectId(code) && code.length === 24) or.push({ _id: code });
  if (/^[0-9a-f]{1,6}$/i.test(code)) or.push({ $expr: { $regexMatch: { input: { $substrCP: [{ $toString: '$_id' }, 18, 6] }, regex: escapeRe(code), options: 'i' } } });
  if (!isClient(user)) {
    const clients = await Client.find({ company: user.company, name: { $regex: escapeRe(term), $options: 'i' } }).select('_id').limit(50).lean();
    if (clients.length) or.push({ client: { $in: clients.map((c) => c._id) } });
  }
  return { $or: or };
}

/* ───────────── reads ───────────── */

export async function listClientTickets(user, { status, q, client, page, limit } = {}) {
  const filter = scopeOf(user);
  if (TICKET_STATUS.includes(status)) filter.status = status;
  if (!isClient(user) && client && mongoose.isValidObjectId(client)) filter.client = client;
  const search = await searchFilter(user, q);
  if (search) Object.assign(filter, search);
  const { page: p, limit: l, skip } = parsePagination({ page, limit });
  const [rows, total] = await Promise.all([
    ClientTicket.find(filter)
      .select({ logs: 0, messages: { $slice: -1 } })
      .populate('client', 'name phone')
      .populate('createdBy', 'name email role')
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(l)
      .lean(),
    ClientTicket.countDocuments(filter),
  ]);
  const counts = await ClientTicket.aggregate([{ $match: { _id: { $in: rows.map((r) => r._id) } } }, { $project: { n: { $size: '$messages' } } }]);
  const sizes = new Map(counts.map((c) => [String(c._id), c.n]));
  const items = rows.map((r) => ({
    ...present({ ...toApiJSON(r), ref: `REQ-${String(r._id).slice(-6).toUpperCase()}`, clientUnread: r.clientUnread, teamUnread: r.teamUnread }, user),
    messageCount: sizes.get(String(r._id)) || 0,
  }));
  return { items, total, page: p, limit: l };
}

export async function clientTicketUnreadCount(user) {
  let scope;
  try {
    scope = scopeOf(user);
  } catch {
    return 0; // no access: no badge
  }
  return ClientTicket.countDocuments({ ...scope, [unreadField(user)]: { $gt: 0 } });
}

/** Full conversation + audit log. Opening it marks the viewer's side as read. */
export async function getClientTicket(user, id) {
  const ticket = await load(user, id);
  const field = unreadField(user);
  if (ticket[field] > 0) {
    ticket[field] = 0;
    await ticket.save({ timestamps: false });
  }
  await ticket.populate([{ path: 'client', select: 'name phone email' }, { path: 'createdBy', select: 'name email role' }]);
  return present(ticket, user);
}

/* ───────────── writes ───────────── */

/** A client opens a request; or the company starts one with a client (`body.clientId`, needs Reply permission). */
export async function createClientTicket(user, body, files) {
  try {
    let client;
    if (isClient(user)) {
      if (!user.client) throw forbidden();
      client = user.client;
    } else {
      assertTeam(user, 'update');
      const found = body?.clientId && mongoose.isValidObjectId(body.clientId) ? await Client.findOne({ _id: body.clientId, company: user.company }).select('_id').lean() : null;
      if (!found) throw badRequest('Choose the client this conversation is with');
      client = found._id;
    }
    const subject = cleanText(body?.subject, 150);
    const text = cleanText(body?.body ?? body?.message, 4000);
    if (!subject) throw badRequest('Give the request a subject');
    if (!text && !files?.length) throw badRequest('Describe what you need or attach a file');
    const fromClient = isClient(user);
    const ticket = new ClientTicket({
      company: user.company,
      client,
      createdBy: user._id,
      subject,
      category: CLIENT_TICKET_CATEGORIES.includes(body?.category) ? body.category : 'service',
      priority: TICKET_PRIORITIES.includes(body?.priority) ? body.priority : 'normal',
      messages: [{ author: user._id, authorName: user.name || user.email, authorRole: user.role, body: text, attachments: attachmentsOf(files) }],
      ...(fromClient ? { teamUnread: 1 } : { clientUnread: 1 }),
    });
    audit(ticket, user, 'created', subject);
    await ticket.save();
    const event = ticket.logs.at(-1);
    notifyClientTicket({
      ticketId: ticket.id, companyId: String(ticket.company), clientId: String(ticket.client), ref: ticket.ref, subject, eventId: String(event._id),
      toTeam: fromClient, actorId: String(user._id),
      title: fromClient ? `${user.name || 'A client'} asked for help` : 'New message from your solar company',
      body: text ? text.slice(0, 120) : 'Sent an attachment',
    });
    return getClientTicket(user, ticket.id);
  } catch (e) {
    await removeUploads(files);
    throw e;
  }
}

export async function addClientTicketMessage(user, id, body, files) {
  try {
    if (!isClient(user)) assertTeam(user, 'update');
    const ticket = await load(user, id);
    const text = cleanText(body?.body ?? body?.message, 4000);
    const attachments = attachmentsOf(files);
    if (!text && !attachments.length) throw badRequest('Write a message or attach a file');
    if (ticket.messages.length >= MAX_MESSAGES) throw badRequest('This conversation is full. Open a new request.');
    const fromClient = isClient(user);
    if (!fromClient && ticket.status === 'closed') throw badRequest('This request is closed. The client can reopen it, or start a new conversation.');

    ticket.messages.push({ author: user._id, authorName: user.name || user.email, authorRole: user.role, body: text, attachments });
    const event = ticket.messages.at(-1);
    audit(ticket, user, 'message', attachments.length ? `Sent a message with ${attachments.length} attachment${attachments.length > 1 ? 's' : ''}` : 'Sent a message');
    ticket.lastMessageAt = new Date();

    let becameStatus = null;
    if (fromClient) {
      ticket.teamUnread += 1;
      if (['resolved', 'closed'].includes(ticket.status)) becameStatus = 'open';
    } else {
      ticket.clientUnread += 1;
      if (ticket.status === 'open') becameStatus = 'in_progress';
    }
    if (becameStatus) {
      audit(ticket, user, becameStatus === 'open' ? 'reopened' : 'status_changed', `${TICKET_STATUS_LABEL[ticket.status]} → ${TICKET_STATUS_LABEL[becameStatus]}`);
      ticket.status = becameStatus;
    }
    await ticket.save();

    notifyClientTicket({
      ticketId: ticket.id, companyId: String(ticket.company), clientId: String(ticket.client), ref: ticket.ref, subject: ticket.subject, eventId: String(event._id),
      toTeam: fromClient, actorId: String(user._id),
      title: fromClient ? `${user.name || 'Your client'} replied` : `${user.name || 'Your solar company'} replied to your request`,
      body: text ? text.slice(0, 120) : `Sent ${attachments.length} attachment${attachments.length > 1 ? 's' : ''}`,
    });
    return getClientTicket(user, ticket.id);
  } catch (e) {
    await removeUploads(files);
    throw e;
  }
}

/** Company: any status. Client: close their request, or reopen a resolved/closed one. */
export async function setClientTicketStatus(user, id, status) {
  if (!TICKET_STATUS.includes(status)) throw badRequest('Invalid request status');
  if (!isClient(user)) assertTeam(user, 'update');
  const ticket = await load(user, id);
  if (status === ticket.status) return getClientTicket(user, id);
  if (isClient(user)) {
    const allowed = status === 'closed' || (status === 'open' && ['resolved', 'closed'].includes(ticket.status));
    if (!allowed) throw forbidden('You can close a request or reopen a resolved one');
  }
  const from = ticket.status;
  ticket.status = status;
  audit(ticket, user, status === 'open' && ['resolved', 'closed'].includes(from) ? 'reopened' : 'status_changed', `${TICKET_STATUS_LABEL[from]} → ${TICKET_STATUS_LABEL[status]}`);
  await ticket.save({ timestamps: false });
  notifyClientTicket({
    ticketId: ticket.id, companyId: String(ticket.company), clientId: String(ticket.client), ref: ticket.ref, subject: ticket.subject, eventId: String(ticket.logs.at(-1)._id),
    toTeam: isClient(user), actorId: String(user._id),
    title: isClient(user) ? `A client ${status === 'closed' ? 'closed' : 'reopened'} their request` : 'Your request was updated',
    body: `Now ${TICKET_STATUS_LABEL[status]}`,
  });
  return getClientTicket(user, id);
}

/* ───────────── clean-up ───────────── */

async function deleteWhere(filter) {
  const tickets = await ClientTicket.find(filter).select('messages.attachments');
  await removeUploads(tickets.flatMap((t) => t.messages.flatMap((m) => m.attachments)));
  await ClientTicket.deleteMany(filter);
}

/** Company deletion. */
export const deleteClientTicketsForCompany = (companyId) => deleteWhere({ company: companyId });
/** Client deletion: their requests and attachments go with them. */
export const deleteClientTicketsForClient = (companyId, clientId) => deleteWhere({ company: companyId, client: clientId });

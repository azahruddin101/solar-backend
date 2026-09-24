// Support tickets between a company (its owner) and the platform admin. Polling-based: the UI refreshes on demand.
import mongoose from 'mongoose';
import path from 'node:path';
import { ROLES, TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUS, TICKET_STATUS_LABEL } from '../constants/index.js';
import { Ticket } from '../models/index.js';
import { badRequest, forbidden, notFound } from '../utils/HttpError.js';
import { objectId } from '../utils/validators.js';
import { notifyTicketUpdate } from './notification.service.js';
import { deleteFile } from './storage.service.js';

const MAX_MESSAGES = 1000;
const isAdmin = (user) => user.role === ROLES.SUPERADMIN;

/* ───────────── helpers ───────────── */

function audit(ticket, user, action, message = '') {
  ticket.logs.push({ action, by: user._id, byName: user.name || user.email, byRole: user.role, message });
}

/** Company owners see their own company's tickets; the super admin sees all. Agents have no access. */
async function load(user, id) {
  if (![ROLES.SUPERADMIN, ROLES.COMPANY].includes(user.role)) throw forbidden();
  const ticket = await Ticket.findById(objectId(id, 'Ticket'));
  if (!ticket || (!isAdmin(user) && String(ticket.company) !== String(user.company))) throw notFound('Ticket');
  return ticket;
}

function present(ticket, viewer) {
  const t = ticket.toJSON();
  t.unread = isAdmin(viewer) ? ticket.adminUnread : ticket.companyUnread;
  delete t.companyUnread;
  delete t.adminUnread;
  return t;
}

function attachmentsOf(files = []) {
  return files.map((f) => ({ url: `/uploads/${f.filename}`, name: String(f.originalname || f.filename).slice(0, 200), mime: f.mimetype, size: f.size }));
}

async function removeUploads(files = []) {
  await Promise.all(files.map((f) => deleteFile(path.basename(f.filename || f.url || ''))));
}

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/* ───────────── reads ───────────── */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Match by ticket id (TKT-ABC123, its 6 characters, or the full id) or by words in the subject. */
function searchFilter(q) {
  const term = String(q ?? '').trim().slice(0, 100);
  if (!term) return null;
  const code = term.replace(/^tkt-?/i, '');
  const or = [{ subject: { $regex: escapeRe(term), $options: 'i' } }];
  if (mongoose.isValidObjectId(code) && code.length === 24) or.push({ _id: code });
  if (/^[0-9a-f]{1,6}$/i.test(code)) or.push({ $expr: { $regexMatch: { input: { $substrCP: [{ $toString: '$_id' }, 18, 6] }, regex: escapeRe(code), options: 'i' } } });
  return { $or: or };
}

export async function listTickets(user, { status, q } = {}) {
  if (![ROLES.SUPERADMIN, ROLES.COMPANY].includes(user.role)) throw forbidden();
  const filter = isAdmin(user) ? {} : { company: user.company };
  if (TICKET_STATUS.includes(status)) filter.status = status;
  const search = searchFilter(q);
  if (search) Object.assign(filter, search);
  const rows = await Ticket.find(filter)
    .select({ logs: 0, messages: { $slice: -1 } })
    .populate('company', 'name logo')
    .populate('createdBy', 'name email')
    .sort({ lastMessageAt: -1 })
    .limit(200);
  const counts = await Ticket.aggregate([{ $match: { _id: { $in: rows.map((r) => r._id) } } }, { $project: { n: { $size: '$messages' } } }]);
  const sizes = new Map(counts.map((c) => [String(c._id), c.n]));
  return rows.map((r) => ({ ...present(r, user), messageCount: sizes.get(String(r._id)) || 0 }));
}

export async function unreadCount(user) {
  if (![ROLES.SUPERADMIN, ROLES.COMPANY].includes(user.role)) return 0;
  const field = isAdmin(user) ? 'adminUnread' : 'companyUnread';
  return Ticket.countDocuments({ ...(isAdmin(user) ? {} : { company: user.company }), [field]: { $gt: 0 } });
}

/** Full conversation + audit log. Opening it marks the viewer's side as read. */
export async function getTicket(user, id) {
  const ticket = await load(user, id);
  const field = isAdmin(user) ? 'adminUnread' : 'companyUnread';
  if (ticket[field] > 0) {
    ticket[field] = 0;
    await ticket.save({ timestamps: false });
  }
  await ticket.populate([{ path: 'company', select: 'name logo email phone' }, { path: 'createdBy', select: 'name email' }]);
  return present(ticket, user);
}

/* ───────────── writes ───────────── */

export async function createTicket(user, body, files) {
  if (user.role !== ROLES.COMPANY) {
    await removeUploads(files);
    throw forbidden('Only a company account can open a ticket');
  }
  try {
    const subject = cleanText(body?.subject, 150);
    const text = cleanText(body?.body ?? body?.message, 4000);
    if (!subject) throw badRequest('Give the ticket a subject');
    if (!text && !files?.length) throw badRequest('Describe the problem or attach a file');
    const ticket = new Ticket({
      company: user.company,
      createdBy: user._id,
      subject,
      category: TICKET_CATEGORIES.includes(body?.category) ? body.category : 'technical',
      priority: TICKET_PRIORITIES.includes(body?.priority) ? body.priority : 'normal',
      messages: [{ author: user._id, authorName: user.name || user.email, authorRole: user.role, body: text, attachments: attachmentsOf(files) }],
      adminUnread: 1,
    });
    audit(ticket, user, 'created', subject);
    await ticket.save();
    return getTicket(user, ticket.id);
  } catch (e) {
    await removeUploads(files);
    throw e;
  }
}

export async function addMessage(user, id, body, files) {
  try {
    const ticket = await load(user, id);
    const text = cleanText(body?.body ?? body?.message, 4000);
    const attachments = attachmentsOf(files);
    if (!text && !attachments.length) throw badRequest('Write a message or attach a file');
    if (ticket.messages.length >= MAX_MESSAGES) throw badRequest('This conversation is full. Open a new ticket.');
    if (isAdmin(user) && ticket.status === 'closed') throw badRequest('This ticket is closed. The company must reopen it first.');

    ticket.messages.push({ author: user._id, authorName: user.name || user.email, authorRole: user.role, body: text, attachments });
    const event = ticket.messages.at(-1);
    audit(ticket, user, 'message', attachments.length ? `Sent a message with ${attachments.length} attachment${attachments.length > 1 ? 's' : ''}` : 'Sent a message');
    ticket.lastMessageAt = new Date();

    let becameStatus = null;
    if (isAdmin(user)) {
      ticket.companyUnread += 1;
      if (ticket.status === 'open') becameStatus = 'in_progress';
    } else {
      ticket.adminUnread += 1;
      if (['resolved', 'closed'].includes(ticket.status)) becameStatus = 'open';
    }
    if (becameStatus) {
      audit(ticket, user, becameStatus === 'open' ? 'reopened' : 'status_changed', `${TICKET_STATUS_LABEL[ticket.status]} → ${TICKET_STATUS_LABEL[becameStatus]}`);
      ticket.status = becameStatus;
    }
    await ticket.save();

    if (isAdmin(user)) {
      notifyTicketUpdate({
        ticketId: ticket.id, companyId: String(ticket.company), ref: ticket.ref, subject: ticket.subject, eventId: String(event._id),
        title: `${user.name || user.email} replied to your ticket`,
        body: text ? text.slice(0, 120) : `Sent ${attachments.length} attachment${attachments.length > 1 ? 's' : ''}`,
      });
    }
    return getTicket(user, ticket.id);
  } catch (e) {
    await removeUploads(files);
    throw e;
  }
}

/** Admin: any status. Company: close its ticket, or reopen a resolved/closed one. */
export async function setStatus(user, id, status) {
  if (!TICKET_STATUS.includes(status)) throw badRequest('Invalid ticket status');
  const ticket = await load(user, id);
  if (status === ticket.status) return getTicket(user, id);
  if (!isAdmin(user)) {
    const allowed = status === 'closed' || (status === 'open' && ['resolved', 'closed'].includes(ticket.status));
    if (!allowed) throw forbidden('You can close a ticket or reopen a resolved one');
  }
  const from = ticket.status;
  ticket.status = status;
  audit(ticket, user, 'status_changed', `${TICKET_STATUS_LABEL[from]} → ${TICKET_STATUS_LABEL[status]}`);
  await ticket.save({ timestamps: false });
  if (isAdmin(user)) {
    notifyTicketUpdate({
      ticketId: ticket.id, companyId: String(ticket.company), ref: ticket.ref, subject: ticket.subject, eventId: String(ticket.logs.at(-1)._id),
      title: 'Ticket status updated', body: `Now ${TICKET_STATUS_LABEL[status]}`,
    });
  }
  return getTicket(user, id);
}

/** Company deletion: remove its tickets and their uploaded files. */
export async function deleteTicketsForCompany(companyId) {
  const tickets = await Ticket.find({ company: companyId }).select('messages.attachments');
  const files = tickets.flatMap((t) => t.messages.flatMap((m) => m.attachments));
  await removeUploads(files);
  await Ticket.deleteMany({ company: companyId });
}

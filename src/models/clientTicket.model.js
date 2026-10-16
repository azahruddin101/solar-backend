import mongoose from 'mongoose';
import { CLIENT_TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUS } from '../constants/index.js';
import { schemaOptions, subSchemaOptions, text } from './schemaOptions.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

const attachmentSchema = new mongoose.Schema({ url: text(300), name: text(200), mime: text(60), size: { type: Number, default: 0 } }, subSchemaOptions);

const messageSchema = new mongoose.Schema(
  {
    author: { type: ObjectId, ref: 'User', required: true },
    authorName: text(200),
    authorRole: text(20), // 'client' | 'company' | 'agent'
    body: text(4000),
    attachments: [attachmentSchema],
  },
  { ...subSchemaOptions, timestamps: { createdAt: true, updatedAt: false } },
);

/** Append-only audit trail (who, what, when). */
const logSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    action: { type: String, required: true, maxlength: 40 }, // created | message | status_changed | reopened
    by: { type: ObjectId, ref: 'User', default: null },
    byName: text(200),
    byRole: text(20),
    message: text(500),
  },
  subSchemaOptions,
);

/**
 * A help request between a company and one of its clients (client portal ↔ company workspace).
 * Kept apart from Ticket (company ↔ platform admin): its own collection, routes and permission, so the platform
 * admin never sees a client's request and a client never sees the company's tickets with the platform.
 */
const clientTicketSchema = new mongoose.Schema(
  {
    company: { type: ObjectId, ref: 'Company', required: true, index: true },
    client: { type: ObjectId, ref: 'Client', required: true, index: true },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    subject: { type: String, required: true, trim: true, maxlength: 150 },
    category: { type: String, enum: CLIENT_TICKET_CATEGORIES, default: 'service' },
    priority: { type: String, enum: TICKET_PRIORITIES, default: 'normal' },
    status: { type: String, enum: TICKET_STATUS, default: 'open', index: true },
    messages: [messageSchema],
    logs: [logSchema],
    clientUnread: { type: Number, default: 0 }, // messages from the company the client hasn't opened
    teamUnread: { type: Number, default: 0 }, // messages from the client the company hasn't opened
    lastMessageAt: { type: Date, default: Date.now, index: true },
  },
  schemaOptions,
);

clientTicketSchema.virtual('ref').get(function ref() {
  return `REQ-${String(this._id).slice(-6).toUpperCase()}`;
});

export const ClientTicket = mongoose.model('ClientTicket', clientTicketSchema);

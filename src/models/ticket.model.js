import mongoose from 'mongoose';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUS } from '../constants/index.js';
import { schemaOptions, subSchemaOptions, text } from './schemaOptions.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

const attachmentSchema = new mongoose.Schema({ url: text(300), name: text(200), mime: text(60), size: { type: Number, default: 0 } }, subSchemaOptions);

const messageSchema = new mongoose.Schema(
  {
    author: { type: ObjectId, ref: 'User', required: true },
    authorName: text(200),
    authorRole: text(20), // 'company' | 'superadmin'
    body: text(4000),
    attachments: [attachmentSchema],
  },
  { ...subSchemaOptions, timestamps: { createdAt: true, updatedAt: false } },
);

/** Append-only audit trail of everything that happened on the ticket (who, what, when). */
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

/** A support conversation between a company and the platform admin. */
const ticketSchema = new mongoose.Schema(
  {
    company: { type: ObjectId, ref: 'Company', required: true, index: true },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    subject: { type: String, required: true, trim: true, maxlength: 150 },
    category: { type: String, enum: TICKET_CATEGORIES, default: 'technical' },
    priority: { type: String, enum: TICKET_PRIORITIES, default: 'normal' },
    status: { type: String, enum: TICKET_STATUS, default: 'open', index: true },
    messages: [messageSchema],
    logs: [logSchema],
    companyUnread: { type: Number, default: 0 }, // messages from the admin the company hasn't opened
    adminUnread: { type: Number, default: 0 }, // messages from the company the admin hasn't opened
    lastMessageAt: { type: Date, default: Date.now, index: true },
  },
  schemaOptions,
);

ticketSchema.virtual('ref').get(function ref() {
  return `TKT-${String(this._id).slice(-6).toUpperCase()}`;
});

export const Ticket = mongoose.model('Ticket', ticketSchema);

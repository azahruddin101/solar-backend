import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

/** In-app inbox entry: one per recipient per event, mirrors what was (or would have been) pushed. */
const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },
    type: text(40),
    title: text(120),
    body: text(400),
    path: text(300), // frontend route to open, e.g. /dashboard/installations/<id>
    data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    eventKey: text(120), // makes a retried event a no-op per recipient
    readAt: { type: Date, default: null },
  },
  schemaOptions,
);

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, eventKey: 1 }, { unique: true, partialFilterExpression: { eventKey: { $gt: '' } } });

export const Notification = mongoose.model('Notification', notificationSchema);

import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

// One row per email sent for an event, so the same email never goes out twice (e.g. the AMC reminder job runs every few
// hours over the same visits). `key` is the event and the recipient; a failed send removes its row so it can be retried.
const emailLogSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, maxlength: 400 },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null, index: true },
    to: text(200),
    subject: text(300),
  },
  schemaOptions,
);

export const EmailLog = mongoose.model('EmailLog', emailLogSchema);

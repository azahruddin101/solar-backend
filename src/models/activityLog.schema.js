import mongoose from 'mongoose';
import { subSchemaOptions, text } from './schemaOptions.js';

/** Append-only audit entry (design phase or installation). */
export const activityLogSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    action: { type: String, required: true, maxlength: 40 },
    step: { type: mongoose.Schema.Types.ObjectId, default: null },
    stepName: text(80),
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: text(200),
    byRole: text(20),
    message: text(1000),
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    imageUrl: text(300),
  },
  subSchemaOptions,
);

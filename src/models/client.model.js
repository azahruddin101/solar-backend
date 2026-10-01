import mongoose from 'mongoose';
import { CLIENT_PROJECT_TYPES, CLIENT_ROOF_TYPES } from '../constants/index.js';
import { activityLogSchema } from './activityLog.schema.js';
import { capWords } from '../utils/text.js';
import { schemaOptions, text } from './schemaOptions.js';

// Clients never sign in; the owning company manages their details.
const clientSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: [true, 'Client name is required'], trim: true, maxlength: 120, set: capWords },
    email: text(200, { lowercase: true }),
    phone: text(40),
    pan: text(10),
    gstNumber: text(15, { uppercase: true }),
    projectType: { type: String, enum: CLIENT_PROJECT_TYPES, default: 'residential' },
    roofType: { type: String, enum: [...CLIENT_ROOF_TYPES, ''], default: '' },
    address: text(400),
    notes: text(1000),
    consumerNumber: text(80),
    kwRequired: { type: Number, min: 0, default: null },
    source: text(80),
    referredBy: {
      name: text(120),
      phone: text(40),
    },
    documents: [
      {
        name: text(200),
        url: text(500),
        size: { type: Number, default: 0 },
        mimetype: text(100),
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    logs: [activityLogSchema],
  },
  schemaOptions,
);

export const Client = mongoose.model('Client', clientSchema);

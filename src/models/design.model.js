import mongoose from 'mongoose';
import { CLIENT_PROJECT_TYPES, CLIENT_PROPOSAL_DECISION, CLIENT_ROOF_TYPES, DESIGN_GRID_TYPES, DESIGN_STATUS } from '../constants/index.js';
import { activityLogSchema } from './activityLog.schema.js';
import { schemaOptions, text } from './schemaOptions.js';

const designSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: ['3d', 'quick'], default: '3d' }, // 'quick' = a proposal from products/packages only, no 3D design
    shareToken: { type: String }, // unguessable id in the public link / QR code; removed (not nulled) to switch the link off
    validUntil: { type: Date, default: null }, // the last day the proposal's price and terms hold
    status: { type: String, enum: DESIGN_STATUS, default: 'draft' },
    billingName: text(160), // name to print on the invoice/receipt, if different from the client's name
    loanRequired: { type: Boolean, default: false },
    gridType: { type: String, enum: [...DESIGN_GRID_TYPES, ''], default: 'on_grid' },
    projectType: { type: String, enum: CLIENT_PROJECT_TYPES, default: 'residential' },
    roofType: { type: String, enum: [...CLIENT_ROOF_TYPES, ''], default: '' },
    cleaningFrequency: { type: Number, default: 0, min: 0, max: 365 }, // cleanings per year
    cleaningCharge: { type: Number, default: 0, min: 0 }, // price per cleaning visit
    clientResponse: {
      decision: { type: String, enum: CLIENT_PROPOSAL_DECISION },
      note: { type: String, trim: true, maxlength: 2000 },
      respondedAt: { type: Date },
      respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    /** Set when the company asks the client to review an updated proposal (cleared when the client responds). */
    clientReviewInvite: {
      message: { type: String, trim: true, maxlength: 2000 },
      sentAt: { type: Date },
      sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    data: { type: mongoose.Schema.Types.Mixed, default: null }, // designer state (roof, objects, config…)
    summary: {
      address: text(300),
      kwp: { type: Number, default: 0 },
      panels: { type: Number, default: 0 },
      cost: { type: Number, default: 0 },
      annualKwh: { type: Number, default: 0 },
      pricing: { type: mongoose.Schema.Types.Mixed, default: null }, // price breakdown (lines, GST, total) used for receipts and the invoice
    },
    logs: [activityLogSchema],
  },
  { ...schemaOptions, minimize: false },
);

// unique among proposals that HAVE a link. (A sparse index would still treat every `null` as a value and refuse a second one.)
designSchema.index({ shareToken: 1 }, { name: 'shareToken_string_unique', unique: true, partialFilterExpression: { shareToken: { $type: 'string' } } });

export const Design = mongoose.model('Design', designSchema);

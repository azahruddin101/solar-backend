import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

// Plan changes are settled outside the app: the company asks, the platform admin approves or rejects.
const PLAN_REQUEST_STATUS = ['pending', 'approved', 'rejected', 'cancelled'];

const planRequestSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    type: { type: String, enum: ['preset', 'custom'], default: 'custom' },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null }, // the preset plan asked for
    status: { type: String, enum: PLAN_REQUEST_STATUS, default: 'pending' },
    message: text(2000),
    requestedLimits: {
      maxClients: { type: Number, default: 25, min: 1 },
      maxDesigns: { type: Number, default: 50, min: 1 },
      maxConcurrentLogins: { type: Number, default: 2, min: 1 },
    },
    adminNotes: text(2000),
    // what the admin approved
    planName: text(80),
    quotedPriceMonthly: { type: Number, default: 0, min: 0 },
    quotedLimits: {
      maxClients: { type: Number, default: 25, min: 1 },
      maxDesigns: { type: Number, default: 50, min: 1 },
      maxConcurrentLogins: { type: Number, default: 2, min: 1 },
    },
    dedicatedPlan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: Date,
  },
  schemaOptions,
);

// at most one pending request per company, enforced by the database (two simultaneous submits cannot both succeed)
planRequestSchema.index({ company: 1 }, { name: 'one_pending_per_company', unique: true, partialFilterExpression: { status: 'pending' } });

export const PlanRequest = mongoose.model('PlanRequest', planRequestSchema);
export { PLAN_REQUEST_STATUS };

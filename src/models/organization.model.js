import mongoose from 'mongoose';
import { COMPANY_STATUS } from '../constants/index.js';
import { schemaOptions, text } from './schemaOptions.js';
import { organizationMastersFields } from './organizationMasters.schema.js';

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: text(200),
    phone: text(40),
    status: { type: String, enum: COMPANY_STATUS, default: 'active' },
    /**
     * Chosen once, when the platform admin creates the company (it cannot be changed afterwards):
     *  - false: one company, one branch and one sign-in — its owner (role branch), who also manages the masters;
     *  - true: a company admin (role company) above branches that each have their own owner on their own email.
     * Companies made before the choice existed get it from migrations/companySetup.migration.js.
     */
    hasBranches: { type: Boolean, required: true, default: false, immutable: true },
    /** Bumped by every branch create / cap change, inside its transaction: concurrent changes conflict and retry one at a time. */
    branchVersion: { type: Number, default: 0 },
    plan: { type: String, default: 'starter' },
    planRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null, index: true },
    limits: {
      maxConcurrentLogins: { type: Number, default: 2, min: 1 },
      maxBranches: { type: Number, default: 1, min: 1 },
      // combined across all branches (see services/orgLimits.service.js); set from the plan, or by the admin on a custom plan
      maxClients: { type: Number, default: 100, min: 1 },
      maxDesigns: { type: Number, default: 200, min: 1 },
    },
    capsMigrated: { type: Boolean, default: false }, // migrations/orgCaps.migration.js ran for this company
    subscription: {
      periodStart: { type: Date, default: null },
      periodEnd: { type: Date, default: null },
      status: { type: String, enum: ['none', 'active', 'cancelled'], default: 'none' },
      billingCycle: { type: String, default: 'monthly' },
      cancelAtPeriodEnd: { type: Boolean, default: false },
    },
    features: {
      pdfBranding: { type: Boolean, default: true },
      excelImport: { type: Boolean, default: true },
    },
    notes: text(1000),
    ...organizationMastersFields(),
  },
  schemaOptions,
);

export const Organization = mongoose.model('Organization', organizationSchema);

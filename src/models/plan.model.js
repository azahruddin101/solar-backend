import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

/** Platform subscription tiers (fixed self-serve + Hotstar-style custom assigned by admin). */
const planSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: text(400),
    kind: { type: String, enum: ['fixed', 'custom'], default: 'fixed' },
    priceMonthly: { type: Number, default: 0, min: 0 },
    maxClients: { type: Number, default: 25, min: 1 }, // every plan has a real cap; nothing is unlimited
    maxDesigns: { type: Number, default: 50, min: 1 },
    maxConcurrentLogins: { type: Number, default: 1, min: 1 },
    features: { type: [{ type: String, trim: true, maxlength: 100 }], default: () => [] }, // what the plan includes, shown to companies
    selfServe: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    /** Dedicated custom offer for one company (created when admin quotes a plan request). */
    forCompany: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null, index: true },
  },
  schemaOptions,
);

export const Plan = mongoose.model('Plan', planSchema);

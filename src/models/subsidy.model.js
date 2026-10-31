import mongoose from 'mongoose';
import { SUBSIDY_STATUS, STEP_STATUS } from '../constants/index.js';
import { activityLogSchema } from './activityLog.schema.js';
import { schemaOptions, subSchemaOptions, text } from './schemaOptions.js';

/** A file kept with a subsidy step (application, approval letter, bank proof…): PDF, image or Excel. Private to the company. */
const subsidyDocumentSchema = new mongoose.Schema(
  {
    name: text(200),
    url: { type: String, required: true }, // /uploads/<companyId>-subsidydoc-<subsidyId>-….<ext> (protected)
    size: { type: Number, min: 0 },
    byName: text(120),
    uploadedAt: { type: Date, default: Date.now },
  },
  subSchemaOptions,
);

/** One step of this client's subsidy, copied from the company's subsidy step template. `remark` is shown to the client. */
const subsidyStepSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Step name is required'], trim: true, maxlength: 80 },
    description: text(400),
    status: { type: String, enum: STEP_STATUS, default: 'pending' },
    remark: text(500),
    completedAt: { type: Date, default: null },
    documents: [subsidyDocumentSchema], // uploaded and removed through their own endpoints
  },
  subSchemaOptions,
);

// A proposal with a subsidy (Design.subsidy.enabled) has exactly one. `client` follows the proposal's client (for the
// portal); `notes` stay private to the company.
const subsidySchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    design: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', required: true, unique: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    status: { type: String, enum: SUBSIDY_STATUS, default: 'in_progress' },
    scheme: text(120), // e.g. PM Surya Ghar, or a state scheme
    applicationNo: text(60), // the application / registration number on the scheme's portal
    consumerNo: text(60), // the client's electricity consumer number
    discom: text(120), // the electricity distribution company handling the approval
    centralAmount: { type: Number, min: 0, default: null }, // expected central subsidy (starts as the proposal's)
    stateAmount: { type: Number, min: 0, default: null }, // expected state subsidy (starts as the proposal's)
    receivedAmount: { type: Number, min: 0, default: null }, // what has actually been credited
    approvedOn: { type: Date, default: null },
    creditedOn: { type: Date, default: null },
    notes: text(1000),
    steps: [subsidyStepSchema],
    logs: [activityLogSchema],
  },
  schemaOptions,
);

export const Subsidy = mongoose.model('Subsidy', subsidySchema);

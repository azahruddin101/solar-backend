import mongoose from 'mongoose';
import { LOAN_STATUS, STEP_STATUS } from '../constants/index.js';
import { activityLogSchema } from './activityLog.schema.js';
import { schemaOptions, subSchemaOptions, text } from './schemaOptions.js';

/** A file kept with a loan step (bank forms, ID proofs, statements…): PDF, image or Excel. Private to the company. */
const loanDocumentSchema = new mongoose.Schema(
  {
    name: text(200),
    url: { type: String, required: true }, // /uploads/<companyId>-loandoc-<loanId>-….<ext> (protected)
    size: { type: Number, min: 0 },
    byName: text(120),
    uploadedAt: { type: Date, default: Date.now },
  },
  subSchemaOptions,
);

/** One step of this client's loan, copied from the company's loan step template. `remark` is shown to the client. */
const loanStepSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Step name is required'], trim: true, maxlength: 80 },
    description: text(400),
    status: { type: String, enum: STEP_STATUS, default: 'pending' },
    remark: text(500),
    completedAt: { type: Date, default: null },
    documents: [loanDocumentSchema], // uploaded and removed through their own endpoints
  },
  subSchemaOptions,
);

// A proposal sold on a loan (Design.loanRequired) has exactly one. `client` follows the proposal's client (for the
// portal); `notes` stay private to the company.
const loanSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    design: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', required: true, unique: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    status: { type: String, enum: LOAN_STATUS, default: 'in_progress' },
    lender: text(120),
    branch: text(120),
    ifsc: text(20),
    accountRef: text(60), // the bank's application / account reference
    amount: { type: Number, min: 0, default: null },
    interestRate: { type: Number, min: 0, max: 100, default: null }, // % per year
    tenureMonths: { type: Number, min: 0, max: 600, default: null },
    emi: { type: Number, min: 0, default: null }, // per month
    downPayment: { type: Number, min: 0, default: null },
    processingFee: { type: Number, min: 0, default: null },
    sanctionedOn: { type: Date, default: null },
    disbursedOn: { type: Date, default: null },
    notes: text(1000),
    steps: [loanStepSchema],
    logs: [activityLogSchema],
  },
  schemaOptions,
);

export const Loan = mongoose.model('Loan', loanSchema);

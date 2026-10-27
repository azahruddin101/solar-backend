import mongoose from 'mongoose';
import { AMC_VISIT_STATUS, AMC_VISIT_WORKFLOW, DEFAULT_STEP_PRIORITY, PROJECT_STATUS, STEP_PRIORITIES, STEP_STATUS } from '../constants/index.js';
import { activityLogSchema } from './activityLog.schema.js';
import { schemaOptions, subSchemaOptions, text } from './schemaOptions.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

const stepSchema = new mongoose.Schema({
  name: { type: String, required: [true, 'Step name is required'], trim: true, maxlength: 80 },
  description: text(400),
  role: text(40), // copied from the template — who should do this step
  priority: { type: String, enum: STEP_PRIORITIES, default: DEFAULT_STEP_PRIORITY },
  assignee: { type: ObjectId, ref: 'User', default: null },
  status: { type: String, enum: STEP_STATUS, default: 'pending' },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
}, subSchemaOptions);

const amcCriterionSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true, maxlength: 200 },
  checked: { type: Boolean, default: false },
  note: text(300),
}, subSchemaOptions);

const amcVisitSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  daysAfterInstallation: { type: Number, default: null, min: 1, max: 3650 },
  kind: { type: String, enum: ['mandatory', 'optional'], default: 'mandatory' },
  price: { type: Number, default: 0, min: 0 },
  description: text(30000, { trim: false }),
  criteria: { type: [amcCriterionSchema], default: () => [] },
  dueDate: { type: Date, default: null },
  clientRequestedDate: { type: Date, default: null },
  request: { type: ObjectId, default: null }, // the client's booking (Design.amcRequests) this visit carries out
  requestNote: text(500),
  workflowStatus: { type: String, enum: AMC_VISIT_WORKFLOW, default: 'requested' },
  assignee: { type: ObjectId, ref: 'User', default: null },
  assigneeName: text(120),
  assignedAt: { type: Date, default: null },
  assignedBy: { type: ObjectId, ref: 'User', default: null },
  status: { type: String, enum: AMC_VISIT_STATUS, default: 'pending' },
  completedAt: { type: Date, default: null },
  completedBy: { type: ObjectId, ref: 'User', default: null },
  completedByName: text(120),
  completionNote: text(1000),
  // parts replaced on the visit, billed to the client as one invoice on the proposal (project.service invoiceAmcParts)
  parts: { type: [new mongoose.Schema({ productName: text(160), qty: { type: Number, default: 0 }, unit: text(20), rate: { type: Number, default: 0 } }, { _id: false })], default: () => [] },
  partsInvoice: { type: ObjectId, ref: 'Invoice', default: null },
  partsInvoiceNo: text(40),
}, subSchemaOptions);

/** The installation of an accepted design: the company's steps, who does each one, and what happened. */
const projectSchema = new mongoose.Schema(
  {
    company: { type: ObjectId, ref: 'Company', required: true, index: true },
    design: { type: ObjectId, ref: 'Design', required: true, unique: true }, // one installation per design
    client: { type: ObjectId, ref: 'Client', required: true },
    status: { type: String, enum: PROJECT_STATUS, default: 'active' },
    installationCompletedAt: { type: Date, default: null },
    steps: [stepSchema],
    amcVisits: { type: [amcVisitSchema], default: () => [] },
    /** Optional AMC package names the client chose (from the company schedule). */
    amcOptionalSelections: { type: [{ type: String, trim: true, maxlength: 80 }], default: () => [] },
    logs: [activityLogSchema],
  },
  schemaOptions,
);

projectSchema.index({ company: 1, 'steps.assignee': 1 });
projectSchema.index({ company: 1, 'amcVisits.assignee': 1 });

export const Project = mongoose.model('Project', projectSchema);

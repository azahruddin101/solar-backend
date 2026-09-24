import mongoose from 'mongoose';
import { PROJECT_STATUS, STEP_STATUS } from '../constants/index.js';
import { activityLogSchema } from './activityLog.schema.js';
import { schemaOptions, subSchemaOptions, text } from './schemaOptions.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

const stepSchema = new mongoose.Schema({
  name: { type: String, required: [true, 'Step name is required'], trim: true, maxlength: 80 },
  description: text(400),
  role: text(40), // copied from the template — who should do this step
  assignee: { type: ObjectId, ref: 'User', default: null },
  status: { type: String, enum: STEP_STATUS, default: 'pending' },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
}, subSchemaOptions);

/** The installation of an accepted design: the company's steps, who does each one, and what happened. */
const projectSchema = new mongoose.Schema(
  {
    company: { type: ObjectId, ref: 'Company', required: true, index: true },
    design: { type: ObjectId, ref: 'Design', required: true, unique: true }, // one installation per design
    client: { type: ObjectId, ref: 'Client', required: true },
    status: { type: String, enum: PROJECT_STATUS, default: 'active' },
    steps: [stepSchema],
    logs: [activityLogSchema],
  },
  schemaOptions,
);

projectSchema.index({ company: 1, 'steps.assignee': 1 });

export const Project = mongoose.model('Project', projectSchema);

import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

// How much a proposal's project is planned to cost, set alongside its expenses so spending can be compared to the plan.
const projectBudgetSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    design: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', required: true, unique: true }, // one budget per proposal
    amount: { type: Number, required: true, min: 0 },
    note: text(300),
    updatedByName: text(120),
  },
  schemaOptions,
);

export const ProjectBudget = mongoose.model('ProjectBudget', projectBudgetSchema);

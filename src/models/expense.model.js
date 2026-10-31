import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

// Money spent on a proposal's project, noted with the reason. It only records what went out — it is not billing.
const expenseSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    design: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', required: true, index: true },
    amount: { type: Number, required: true, min: 0.01 },
    reason: { type: String, required: true, trim: true, maxlength: 300 },
    note: text(500), // optional detail, e.g. the vendor or bill number
    billUrl: { type: String, default: '' }, // vendor bill (PDF, image or Excel), /uploads/<file>; protected
    billName: text(200),
    billSize: { type: Number, default: 0, min: 0 },
    spentOn: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: text(120),
  },
  schemaOptions,
);
expenseSchema.index({ company: 1, design: 1, spentOn: -1 });

export const Expense = mongoose.model('Expense', expenseSchema);

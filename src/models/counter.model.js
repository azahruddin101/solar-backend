import mongoose from 'mongoose';

// Running numbers per company (receipts, invoices): RCT-0001, RCT-0002…
const counterSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ company: 1, key: 1 }, { unique: true });

export const Counter = mongoose.model('Counter', counterSchema);

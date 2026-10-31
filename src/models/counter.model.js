import mongoose from 'mongoose';

// Running numbers per company (e-way bills, bills, legacy invoices): EWB-0001, BILL-0001…
const counterSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ company: 1, key: 1 }, { unique: true });

export const Counter = mongoose.model('Counter', counterSchema);

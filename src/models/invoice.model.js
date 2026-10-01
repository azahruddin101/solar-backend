import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

// Tax invoices. Usually for a booked proposal (`design` + `client`); a "direct" invoice has neither and carries the
// buyer's details in `billTo` instead. Each generation is a new row; `pricing` is frozen at issue time.
const billToSchema = new mongoose.Schema(
  {
    name: text(120),
    phone: text(40),
    email: text(200, { lowercase: true }),
    address: text(400),
    gstNumber: text(15, { uppercase: true }),
  },
  { _id: false },
);

const invoiceSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    design: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', default: null, index: true }, // null = direct invoice
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    billTo: { type: billToSchema, default: null }, // who the invoice is addressed to when there is no client record
    invoiceNo: { type: String, required: true },
    issuedOn: { type: Date, default: Date.now },
    title: text(160), // the proposal name
    total: { type: Number, default: 0 },
    pricing: { type: mongoose.Schema.Types.Mixed, default: null },
    termsAndConditions: { type: String, default: '' }, // invoice-specific T&C
    pdfName: text(200), // stored file, served at /uploads/<pdfName>
    createdByName: text(120),
  },
  schemaOptions,
);
invoiceSchema.index({ company: 1, invoiceNo: 1 }, { unique: true });
invoiceSchema.index({ company: 1, design: 1, createdAt: -1 });

export const Invoice = mongoose.model('Invoice', invoiceSchema);

import mongoose from 'mongoose';
import { PAYMENT_MODES } from '../constants/index.js';
import { schemaOptions, text } from './schemaOptions.js';

const billToSchema = new mongoose.Schema(
  {
    name: text(120),
    phone: text(40),
    email: text(200, { lowercase: true }),
    address: text(400),
  },
  { _id: false },
);

// A payment received against a won proposal, or a standalone "direct" receipt with no proposal.
const paymentSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    design: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', default: null, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    billTo: { type: billToSchema, default: null },
    title: text(160),
    receiptNo: { type: String, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    mode: { type: String, enum: PAYMENT_MODES, default: 'cash' },
    reference: text(80), // UPI / transaction id, cheque number, bank reference…
    receivedOn: { type: Date, default: Date.now },
    note: text(300),
    contractTotal: { type: Number, default: 0 }, // the proposal total when this was received
    balanceAfter: { type: Number, default: 0 }, // what was still to pay after this payment
    pdfName: text(200), // receipt PDF in uploads / S3, served at /uploads/<pdfName>
    createdByName: text(120),
  },
  schemaOptions,
);
paymentSchema.index({ company: 1, receiptNo: 1 }, { unique: true });

export const Payment = mongoose.model('Payment', paymentSchema);

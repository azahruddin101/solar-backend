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

// Money received: today one row per bill (bill.service.js); older rows are the receipts that existed before bills.
const paymentSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    design: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', default: null, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    bill: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', default: null }, // the payment of a bill (bill.service.js); rows made before bills existed have none
    billTo: { type: billToSchema, default: null },
    title: text(160),
    receiptNo: { type: String, required: true }, // the bill's number (older rows: their own RCT-… receipt number)
    amount: { type: Number, required: true, min: 0.01 }, // what is still held: refunds for returned goods come off it
    refunded: { type: Number, default: 0 }, // total paid back so far (credit notes)
    mode: { type: String, enum: PAYMENT_MODES, default: 'cash' },
    reference: text(80), // UPI / transaction id, cheque number, bank reference…
    receivedOn: { type: Date, default: Date.now },
    note: text(300),
    contractTotal: { type: Number, default: 0 }, // the proposal total when this was received
    balanceAfter: { type: Number, default: 0 }, // what was still to pay after this payment
    pdfName: text(200), // older rows: the receipt PDF that was archived for them
    createdByName: text(120),
  },
  schemaOptions,
);
paymentSchema.index({ company: 1, receiptNo: 1 }, { unique: true });

export const Payment = mongoose.model('Payment', paymentSchema);

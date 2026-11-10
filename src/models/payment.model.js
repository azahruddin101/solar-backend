import mongoose from 'mongoose';
import { PAYMENT_MODES } from '../constants/index.js';
import { idempotencyField, idempotencyIndex } from '../utils/idempotency.js';
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

// Money received. A row with an `ewayBill` is the payment taken when that bill was generated (a bill is paid when it
// is made). A row with neither `bill` nor `ewayBill` is a RECEIPT (receipt.service.js): any amount a client pays, numbered RCPT-0001…
// (rows from before 2026-11-03 carry their old RCT-… numbers). A row with a `bill` is the payment of an older invoice
// (bill.service.js), numbered like that invoice.
const paymentSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    design: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', default: null, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    ewayBill: { type: mongoose.Schema.Types.ObjectId, ref: 'EwayBill', default: null, index: true }, // the payment recorded when a bill was generated (ewayBill.service.js); numbered PMT-<bill no.>
    bill: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', default: null }, // the payment of a bill (bill.service.js); rows made before bills existed have none
    billTo: { type: billToSchema, default: null },
    title: text(160),
    receiptNo: { type: String, required: true }, // RCPT-… for a receipt; the invoice's number for the payment of an older invoice
    amount: { type: Number, required: true, min: 0.01 }, // what is still held: refunds for returned goods come off it
    refunded: { type: Number, default: 0 }, // total paid back so far (credit notes)
    mode: { type: String, enum: PAYMENT_MODES, default: 'cash' },
    reference: text(80), // UPI / transaction id, cheque number, bank reference…
    receivedOn: { type: Date, default: Date.now },
    note: text(300),
    reason: text(300), // receipts: what the money is for (optional; printed on the receipt)
    receivedByName: text(120), // receipts: the staff member who took the money and gave the receipt
    contractTotal: { type: Number, default: 0 }, // receipts: what was billed to the party when this was received (older rows: the proposal total)
    balanceAfter: { type: Number, default: 0 }, // what was still to pay after this payment
    pdfName: text(200), // older rows: the receipt PDF that was archived for them
    createdByName: text(120),
    idempotencyKey: idempotencyField, // the key of the request that made this receipt, so a repeated request returns it
  },
  schemaOptions,
);
paymentSchema.index({ company: 1, receiptNo: 1 }, { unique: true });
paymentSchema.index(...idempotencyIndex);

export const Payment = mongoose.model('Payment', paymentSchema);

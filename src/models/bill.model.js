import mongoose from 'mongoose';
import { BILL_STATUS, PAYMENT_MODES } from '../constants/index.js';
import { idempotencyField, idempotencyIndex } from '../utils/idempotency.js';
import { schemaOptions, text } from './schemaOptions.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

// A service charged on the bill (installation, wiring, transport…); copied from the company's installation charges or typed.
const serviceSchema = new mongoose.Schema(
  {
    chargeId: { type: ObjectId, ref: 'InstallationCharge', default: null },
    name: text(160),
    description: text(300),
    hsn: text(20), // SAC code
    qty: { type: Number, min: 0, default: 1 },
    unit: text(20, { default: 'Nos' }),
    rate: { type: Number, min: 0, default: 0 },
    gstPercent: { type: Number, min: 0, max: 100, default: 18 },
  },
  { _id: false },
);

// What was paid when the bill was made (a bill is always paid: it is the payment document for the goods and services on it).
const paymentSchema = new mongoose.Schema(
  {
    amount: { type: Number, default: 0 },
    mode: { type: String, enum: PAYMENT_MODES, default: 'cash' },
    reference: text(80),
    receivedOn: { type: Date, default: Date.now },
    note: text(300),
  },
  { _id: false },
);

/**
 * The second document of the sale chain: one or more e-way bills of the same client (or proposal) plus service
 * charges, paid in full when the bill is generated. Its `pricing` (goods lines from the e-way bills, the services, an
 * optional discount and GST) is frozen then; the payment is recorded as a Payment row as well, so the
 * proposal's ledger and the dashboards count it. An invoice later consolidates the bills (`status` → invoiced).
 */
const billSchema = new mongoose.Schema(
  {
    company: { type: ObjectId, ref: 'Company', required: true, index: true },
    design: { type: ObjectId, ref: 'Design', default: null, index: true },
    client: { type: ObjectId, ref: 'Client', required: true, index: true },
    billNo: { type: String, required: true },
    issuedOn: { type: Date, default: Date.now },
    title: text(160),
    ewayBills: { type: [{ type: ObjectId, ref: 'EwayBill' }], default: () => [] },
    services: { type: [serviceSchema], default: () => [] },
    pricing: { type: mongoose.Schema.Types.Mixed, default: null },
    total: { type: Number, default: 0 },
    paid: { type: paymentSchema, default: () => ({}) },
    payment: { type: ObjectId, ref: 'Payment', default: null }, // the payment row created with the bill
    creditedTotal: { type: Number, default: 0 }, // what has been paid back for returned goods (see creditNote.model.js)
    status: { type: String, enum: BILL_STATUS, default: 'paid', index: true },
    invoice: { type: ObjectId, ref: 'Invoice', default: null },
    pdfName: text(200),
    // a voided bill stays as the record: its e-way bills went back to open (or to stock) and its payment row was removed
    voidedAt: { type: Date, default: null },
    voidReason: text(300),
    voidedByName: text(120),
    createdByName: text(120),
    idempotencyKey: idempotencyField, // the key of the request that made this document, so a repeated request returns it
  },
  { ...schemaOptions, minimize: false },
);
billSchema.index({ company: 1, billNo: 1 }, { unique: true });
billSchema.index(...idempotencyIndex);
billSchema.index({ company: 1, design: 1, createdAt: -1 });
billSchema.index({ company: 1, client: 1, createdAt: -1 });

export const Bill = mongoose.model('Bill', billSchema);

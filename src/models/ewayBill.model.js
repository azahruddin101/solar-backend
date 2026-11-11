import mongoose from 'mongoose';
import { EWAY_BILL_STATUS, PAYMENT_MODES, TRANSPORT_MODES, TRANSPORT_REASONS } from '../constants/index.js';
import { idempotencyField, idempotencyIndex } from '../utils/idempotency.js';
import { schemaOptions, text } from './schemaOptions.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

const serviceSchema = new mongoose.Schema(
  {
    chargeId: { type: ObjectId, ref: 'InstallationCharge', default: null },
    name: text(160),
    description: text(300),
    hsn: text(20),
    qty: { type: Number, min: 0, default: 1 },
    unit: text(20, { default: 'Nos' }),
    rate: { type: Number, min: 0, default: 0 },
    gstPercent: { type: Number, min: 0, max: 100, default: 18 },
  },
  { _id: false },
);

// How the goods travel. All free text apart from the mode and the reason; the two dates are YYYY-MM-DD.
const transportSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: TRANSPORT_MODES, default: 'road' },
    vehicleNo: text(20, { uppercase: true }),
    transporter: text(120),
    transporterId: text(15, { uppercase: true }), // the transporter's GSTIN / enrolment id
    docNo: text(80), // LR / RR / airway bill number
    docDate: text(20),
    fromPlace: text(200),
    toPlace: text(200),
    distanceKm: { type: Number, min: 0, default: null },
    reason: { type: String, enum: TRANSPORT_REASONS, default: 'supply' },
  },
  { _id: false },
);

/**
 * Shown to users as the BILL (since 2026-11-03; numbered BILL-0001…). The model kept its name so stored data needs no migration.
 * Goods leaving stock for a client: the first document of the sale chain (e-way bill → bill → invoice). Its lines are
 * taken from stock when it is created (stock.service.js allocateInvoiceLines) and priced from their batches; `pricing`
 * is frozen then. Hangs on a booked proposal (`design`) or, for a sale with no proposal, on the client alone.
 * `ewayNo` is the company's own running number; `govtEwayNo` the 12-digit number from the GST portal, if generated.
 */
const ewayBillSchema = new mongoose.Schema(
  {
    company: { type: ObjectId, ref: 'Company', required: true, index: true },
    design: { type: ObjectId, ref: 'Design', default: null, index: true },
    client: { type: ObjectId, ref: 'Client', required: true, index: true },
    ewayNo: { type: String, required: true },
    govtEwayNo: text(12),
    issuedOn: { type: Date, default: Date.now },
    title: text(160), // the proposal name, or the client's
    lines: { type: [mongoose.Schema.Types.Mixed], default: () => [] }, // the priced lines (goods and/or services; see invoicePricing.service.js)
    services: { type: [serviceSchema], default: () => [] }, // service charges on this bill (also in pricing.lines with kind service)
    pricing: { type: mongoose.Schema.Types.Mixed, default: null },
    total: { type: Number, default: 0 },
    transport: { type: transportSchema, default: () => ({}) },
    // whether a delivery challan was asked for with this bill (asked since 2026-11-10; bills from before always had one)
    withChallan: { type: Boolean, default: true },
    // a bill is paid when it is generated: `amount` is what was taken then (the total, less any advance already held on receipts)
    paid: {
      type: new mongoose.Schema({ settled: { type: Boolean, default: false }, amount: { type: Number, default: 0 }, mode: { type: String, enum: PAYMENT_MODES, default: 'cash' }, reference: text(80) }, { _id: false }),
      default: null,
    },
    note: text(300),
    status: { type: String, enum: EWAY_BILL_STATUS, default: 'open', index: true },
    bill: { type: ObjectId, ref: 'Bill', default: null }, // set when a bill is generated for it
    cancelledAt: { type: Date, default: null },
    cancelReason: text(300),
    supersededBy: { type: ObjectId, ref: 'EwayBill', default: null },
    supersedes: { type: ObjectId, ref: 'EwayBill', default: null },
    supersededAt: { type: Date, default: null },
    pdfName: text(200), // archived PDF, served at /uploads/<pdfName>
    createdByName: text(120),
    idempotencyKey: idempotencyField, // the key of the request that made this document, so a repeated request returns it
  },
  { ...schemaOptions, minimize: false },
);
ewayBillSchema.index({ company: 1, ewayNo: 1 }, { unique: true });
ewayBillSchema.index(...idempotencyIndex);
ewayBillSchema.index({ company: 1, design: 1, createdAt: -1 });
ewayBillSchema.index({ company: 1, client: 1, createdAt: -1 });

export const EwayBill = mongoose.model('EwayBill', ewayBillSchema);

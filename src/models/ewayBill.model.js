import mongoose from 'mongoose';
import { EWAY_BILL_STATUS, TRANSPORT_MODES, TRANSPORT_REASONS } from '../constants/index.js';
import { idempotencyField, idempotencyIndex } from '../utils/idempotency.js';
import { schemaOptions, text } from './schemaOptions.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

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
    lines: { type: [mongoose.Schema.Types.Mixed], default: () => [] }, // the priced stock lines (see invoicePricing.service.js)
    pricing: { type: mongoose.Schema.Types.Mixed, default: null },
    total: { type: Number, default: 0 },
    transport: { type: transportSchema, default: () => ({}) },
    note: text(300),
    status: { type: String, enum: EWAY_BILL_STATUS, default: 'open', index: true },
    bill: { type: ObjectId, ref: 'Bill', default: null }, // set when a bill is generated for it
    cancelledAt: { type: Date, default: null },
    cancelReason: text(300),
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

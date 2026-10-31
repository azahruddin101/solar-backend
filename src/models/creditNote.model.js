import mongoose from 'mongoose';
import { PAYMENT_MODES } from '../constants/index.js';
import { idempotencyField, idempotencyIndex } from '../utils/idempotency.js';
import { schemaOptions, text } from './schemaOptions.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

// What was paid back for the goods that were returned.
const refundSchema = new mongoose.Schema(
  {
    amount: { type: Number, default: 0 },
    mode: { type: String, enum: PAYMENT_MODES, default: 'cash' },
    reference: text(80),
    refundedOn: { type: Date, default: Date.now },
    note: text(300),
  },
  { _id: false },
);

/**
 * A credit note: some of the goods on a paid bill came back. It names the returned lines (`billLine` is the index of the
 * line on the bill's frozen pricing), prices them from that line pro rata (GST and the bill's discount share included),
 * puts the goods back into stock and refunds the money, which takes it off the payment of the bill. The bill and its
 * invoice stay as they were issued. Credit notes are never edited or deleted.
 */
const creditNoteSchema = new mongoose.Schema(
  {
    company: { type: ObjectId, ref: 'Company', required: true, index: true },
    design: { type: ObjectId, ref: 'Design', default: null, index: true },
    client: { type: ObjectId, ref: 'Client', required: true, index: true },
    bill: { type: ObjectId, ref: 'Bill', required: true, index: true },
    invoice: { type: ObjectId, ref: 'Invoice', default: null }, // the invoice the bill was on when the goods came back
    creditNo: { type: String, required: true },
    issuedOn: { type: Date, default: Date.now },
    title: text(160),
    reason: text(300),
    lines: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
    pricing: { type: mongoose.Schema.Types.Mixed, default: null },
    total: { type: Number, default: 0 },
    refund: { type: refundSchema, default: () => ({}) },
    pdfName: text(200),
    createdByName: text(120),
    idempotencyKey: idempotencyField,
  },
  { ...schemaOptions, minimize: false },
);
creditNoteSchema.index({ company: 1, creditNo: 1 }, { unique: true });
creditNoteSchema.index({ company: 1, design: 1, createdAt: -1 });
creditNoteSchema.index({ company: 1, client: 1, createdAt: -1 });
creditNoteSchema.index(...idempotencyIndex);

export const CreditNote = mongoose.model('CreditNote', creditNoteSchema);

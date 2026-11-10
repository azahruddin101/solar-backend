import mongoose from 'mongoose';
import { subSchemaOptions, schemaOptions, text } from './schemaOptions.js';

// A saved estimate (Dashboard → Estimation): a quick price list for a client, not part of the proposal/billing chain.
// Standalone on purpose — lines are copied from the catalog at the time, so later catalog changes never alter it.
const lineSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['package', 'product', 'service', 'custom'], default: 'custom' },
    refId: text(40), // the catalog entry it came from (for the picker's quantity steppers); not a reference
    name: text(140),
    detail: text(600),
    hsn: text(20),
    unit: text(20),
    qty: { type: Number, default: 1, min: 0 },
    rate: { type: Number, default: 0, min: 0 }, // before GST
    gstPercent: { type: Number, default: 18, min: 0, max: 100 },
  },
  { _id: false, ...subSchemaOptions },
);

const estimateSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    client: {
      clientId: text(40), // set when picked from the client list, empty when typed by hand
      name: text(120),
      phone: text(40),
      email: text(200),
      address: text(400),
    },
    date: text(10), // YYYY-MM-DD
    withGst: { type: Boolean, default: true },
    lines: { type: [lineSchema], default: [] },
    notes: text(1000),
    design: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', default: null }, // the 2D proposal last made from this estimate (Convert to proposal)
    // worked out by the server on every save, so lists need not read the lines
    subtotal: { type: Number, default: 0 },
    gstTotal: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    createdByName: text(120),
  },
  schemaOptions,
);
estimateSchema.index({ company: 1, createdAt: -1 });

export const Estimate = mongoose.model('Estimate', estimateSchema);

import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

// Tax invoices. Usually for a booked proposal (`design` + `client`); a "direct" invoice has neither and carries the
// buyer's details in `billTo` instead. Each generation is a new row; `pricing` is frozen at issue time.
const billToSchema = new mongoose.Schema(
  {
    name: text(120),
    company: text(120), // the buyer's company name, when billing a company (optional)
    phone: text(40),
    email: text(200, { lowercase: true }),
    address: text(400),
    gstNumber: text(15, { uppercase: true }),
  },
  { _id: false },
);

// Optional reference and delivery details printed on the invoice (all free text; the two dates are YYYY-MM-DD).
const detailsSchema = new mongoose.Schema(
  {
    reference: text(120), // reference no. & date
    otherReferences: text(120),
    buyerOrderNo: text(80),
    buyerOrderDate: text(20),
    dispatchDocNo: text(80),
    deliveryNoteDate: text(20),
    dispatchedThrough: text(120),
    destination: text(120),
    termsOfDelivery: text(300),
  },
  { _id: false },
);

const invoiceSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    design: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', default: null, index: true }, // null = direct invoice
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    billTo: { type: billToSchema, default: null }, // who the invoice is addressed to when there is no client record
    billToCompany: text(120), // an invoice on a proposal: the buyer's company name to print under "Bill to" (optional)
    details: { type: detailsSchema, default: null }, // optional reference & delivery details
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

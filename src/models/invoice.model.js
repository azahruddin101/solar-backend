import mongoose from 'mongoose';
import { idempotencyField, idempotencyIndex } from '../utils/idempotency.js';
import { INVOICE_KIND, INVOICE_STATUS } from '../constants/index.js';
import { schemaOptions, text } from './schemaOptions.js';

// Tax invoices. Usually for a booked proposal (`design` + `client`); a "direct" invoice has neither and carries the
// buyer's details in `billTo` instead. Each generation is a new row; `pricing` is frozen at issue time.
// Invoices made from bills (`bills`) consolidate the bills' frozen pricing; see billing.service.js createInvoiceFromBills.
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
    // older invoices have no status and count as issued; a void one is kept for the record, its bills are free again
    status: { type: String, enum: INVOICE_STATUS, default: 'issued' },
    // older invoices have no kind and count as sales, except the AMC ones the migration marks (migrations/invoiceKind.migration.js)
    kind: { type: String, enum: INVOICE_KIND, default: 'sale' },
    voidedAt: { type: Date, default: null },
    voidReason: text(300),
    voidedByName: text(120),
    createdByName: text(120),
    idempotencyKey: idempotencyField, // the key of the request that made this document, so a repeated request returns it
    // an invoice generated from bills (the e-way bill → bill → invoice chain): the bills it settles, with a copy of
    // their numbers and amounts for the PDF
    bills: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Bill' }], default: () => [] },
    billRefs: {
      type: [new mongoose.Schema({ bill: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill' }, billNo: text(40), issuedOn: { type: Date, default: null }, total: { type: Number, default: 0 }, ewayNos: { type: [String], default: () => [] } }, { _id: false })],
      default: () => [],
    },
  },
  schemaOptions,
);
invoiceSchema.index({ company: 1, invoiceNo: 1 }, { unique: true });
invoiceSchema.index(...idempotencyIndex);
invoiceSchema.index({ company: 1, design: 1, createdAt: -1 });

export const Invoice = mongoose.model('Invoice', invoiceSchema);

import mongoose from 'mongoose';
import { capFirst } from '../utils/text.js';
import { schemaOptions, text } from './schemaOptions.js';

// Who a batch of stock was bought from. Each company keeps its own list. `categories`: the company's product categories
// the supplier sells (optional; a deleted category is taken off its suppliers).
const supplierSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: [true, 'Supplier name is required'], trim: true, maxlength: 120, set: capFirst },
    phone: text(40),
    email: text(200, { lowercase: true }),
    gstNumber: text(15, { uppercase: true }),
    address: text(400),
    notes: text(500),
    categories: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category' }], default: () => [], index: true },
  },
  schemaOptions,
);

export const Supplier = mongoose.model('Supplier', supplierSchema);

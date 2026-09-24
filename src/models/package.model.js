import mongoose from 'mongoose';
import { capFirst } from '../utils/text.js';
import { schemaOptions, text } from './schemaOptions.js';

const packageItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    qty: { type: Number, default: 1, min: 0 },
    unit: { type: String, default: 'Nos', set: capFirst },
  },
  { _id: false },
);

const packageSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 140, set: capFirst },
    kw: { type: Number, default: 0 },
    price: { type: Number, required: true, min: 0 },
    description: text(500),
    items: { type: [packageItemSchema], default: [] },
  },
  schemaOptions,
);

export const Package = mongoose.model('Package', packageSchema);

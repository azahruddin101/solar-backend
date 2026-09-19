import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

// Clients never sign in; the owning company manages their details.
const clientSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: [true, 'Client name is required'], trim: true, maxlength: 120 },
    email: text(200, { lowercase: true }),
    phone: text(40),
    address: text(400),
    notes: text(1000),
  },
  schemaOptions,
);

export const Client = mongoose.model('Client', clientSchema);

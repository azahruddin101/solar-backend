import mongoose from 'mongoose';
import { DESIGN_STATUS } from '../constants/index.js';
import { schemaOptions, text } from './schemaOptions.js';

const designSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: DESIGN_STATUS, default: 'draft' },
    data: { type: mongoose.Schema.Types.Mixed, default: null }, // designer state (roof, objects, config…)
    summary: {
      address: text(300),
      kwp: { type: Number, default: 0 },
      panels: { type: Number, default: 0 },
      cost: { type: Number, default: 0 },
      annualKwh: { type: Number, default: 0 },
    },
  },
  { ...schemaOptions, minimize: false },
);

export const Design = mongoose.model('Design', designSchema);

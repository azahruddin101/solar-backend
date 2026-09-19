import mongoose from 'mongoose';
import { PILLAR_SHAPES } from '../constants/index.js';
import { schemaOptions } from './schemaOptions.js';

const pillarSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 60 },
    shape: { type: String, enum: PILLAR_SHAPES, default: 'square' },
    pricePerFt: { type: Number, min: 0, default: 0 },
  },
  schemaOptions,
);

export const Pillar = mongoose.model('Pillar', pillarSchema);

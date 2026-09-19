import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

const panelSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    brand: { type: String, required: [true, 'Brand is required'], trim: true, maxlength: 60 },
    model: text(60),
    watts: { type: Number, required: [true, 'Watt is required'], min: [1, 'Watt must be greater than 0'], max: 2000 },
    manufactureYear: { type: Number, min: 1990, max: 2100, default: () => new Date().getFullYear() },
    warrantyYears: { type: Number, min: 0, max: 60, default: 25 },
    length: { type: Number, min: 0.2, max: 5, default: 1.9 }, // metres
    width: { type: Number, min: 0.2, max: 5, default: 1.05 },
    price: { type: Number, min: 0, default: 0 }, // per panel
  },
  schemaOptions,
);

export const Panel = mongoose.model('Panel', panelSchema);

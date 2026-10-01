import mongoose from 'mongoose';
import { capFirst } from '../utils/text.js';
import { schemaOptions, text } from './schemaOptions.js';

// A company's own installation-charge option (inverter installation, wiring…). Proposals pick from this list
// and type the price per proposal; `defaultPrice` only pre-fills that box.
const installationChargeSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: [true, 'Charge name is required'], trim: true, maxlength: 80, set: capFirst },
    description: text(300),
    defaultPrice: { type: Number, default: 0, min: 0 },
    gstPercent: { type: Number, default: 18, min: 0, max: 100 },
  },
  schemaOptions,
);

export const InstallationCharge = mongoose.model('InstallationCharge', installationChargeSchema);

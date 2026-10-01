import mongoose from 'mongoose';
import { capFirst } from '../utils/text.js';
import { schemaOptions, text } from './schemaOptions.js';

// A heading the company groups its categories under ("Structures", "Electricals"). It holds categories,
// never products: parent category → category → products. The proposal's bill of materials is printed
// in these groups.
const parentCategorySchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: [true, 'Parent category name is required'], trim: true, maxlength: 60, set: capFirst },
    description: text(300),
    position: { type: Number, default: 0 }, // order of the groups, on screen and in the bill of materials
  },
  schemaOptions,
);

export const ParentCategory = mongoose.model('ParentCategory', parentCategorySchema);

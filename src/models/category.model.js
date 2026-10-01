import mongoose from 'mongoose';
import { PRODUCT_TYPES } from '../constants/index.js';
import { capFirst } from '../utils/text.js';
import { schemaOptions, text } from './schemaOptions.js';

// A company's own product category, optionally filed under a parent category (see parentCategory.model.js). `type` says how the designer uses its products (not at all, as solar
// panels, or as poles); the company can change it, and the products follow (Product.type).
const categorySchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: [true, 'Category name is required'], trim: true, maxlength: 60, set: capFirst },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'ParentCategory', default: null, index: true },
    type: { type: String, enum: PRODUCT_TYPES, default: 'general' },
    description: text(300),
    position: { type: Number, default: 0 }, // order of the catalog tabs
    specKeys: [{ type: String, trim: true, maxlength: 60 }], // suggested specification names, pre-filled on new products
  },
  schemaOptions,
);

export const Category = mongoose.model('Category', categorySchema);

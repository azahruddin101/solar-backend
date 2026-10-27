import mongoose from 'mongoose';
import { ATTRIBUTE_TYPES, PRODUCT_TYPES } from '../constants/index.js';
import { capFirst } from '../utils/text.js';
import { schemaOptions, text } from './schemaOptions.js';

/**
 * One attribute the category's products carry, e.g. { key: 'efficiency', label: 'Efficiency (%)', dataType: 'number' }.
 * Products store the values under `key` (Product.attributes); see services/attribute.service.js for the rules.
 */
const attributeSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 40 },
    label: { type: String, required: [true, 'Attribute label is required'], trim: true, maxlength: 60 },
    dataType: { type: String, enum: ATTRIBUTE_TYPES, default: 'text' },
    isRequired: { type: Boolean, default: false },
    options: { type: [{ type: String, trim: true, maxlength: 60 }], default: () => [] }, // 'select' only
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false },
);

// A company's own product category, optionally filed under a parent category (see parentCategory.model.js). `type` says how the designer uses its products (not at all, as solar
// panels, or as poles); the company can change it, and the products follow (Product.type).
const categorySchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: [true, 'Category name is required'], trim: true, maxlength: 60, set: capFirst },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'ParentCategory', default: null, index: true },
    type: { type: String, enum: PRODUCT_TYPES, default: 'general' },
    description: text(300),
    icon: text(300), // optional PNG/JPG/WebP under /uploads (≤50 KB)
    position: { type: Number, default: 0 }, // order of the catalog tabs
    attributes: { type: [attributeSchema], default: () => [] },
  },
  schemaOptions,
);

export const Category = mongoose.model('Category', categorySchema);

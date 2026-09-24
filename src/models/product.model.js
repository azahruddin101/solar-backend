import mongoose from 'mongoose';
import { PILLAR_SHAPES, PRODUCT_TYPES } from '../constants/index.js';
import { capFirst } from '../utils/text.js';
import { schemaOptions, text } from './schemaOptions.js';
import { specSchema } from './spec.schema.js';

// A product in one of the company's categories. `type` mirrors the category's type.
const productSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    type: { type: String, enum: PRODUCT_TYPES, default: 'general', index: true },
    name: { type: String, required: [true, 'Product name is required'], trim: true, maxlength: 120, set: capFirst },
    brand: text(60, { set: capFirst }),
    model: text(60),
    sku: text(60),
    hsnCode: text(20), // GST Harmonized System of Nomenclature code
    unit: text(20, { default: 'Piece', set: capFirst }), // from the company’s product-units list
    price: { type: Number, min: [0, 'Price cannot be negative'], default: 0 }, // per unit
    quantity: { type: Number, min: [0, 'Quantity cannot be negative'], default: 0 }, // stock on hand
    warrantyYears: { type: Number, min: 0, max: 60, default: 0 },
    description: text(1000),
    specs: [specSchema],

    // type 'panels'
    watts: { type: Number, min: [1, 'Watt must be greater than 0'], max: 2000 },
    manufactureYear: { type: Number, min: 1990, max: 2100 },
    length: { type: Number, min: 0.2, max: 5 }, // metres
    width: { type: Number, min: 0.2, max: 5 },
    // type 'poles'
    shape: { type: String, enum: PILLAR_SHAPES },
  },
  schemaOptions,
);

export const Product = mongoose.model('Product', productSchema);

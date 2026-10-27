import mongoose from 'mongoose';
import { PILLAR_SHAPES, PRODUCT_TYPES } from '../constants/index.js';
import { capFirst } from '../utils/text.js';
import { schemaOptions, subSchemaOptions, text } from './schemaOptions.js';

// A product in one of the company's categories. `type` mirrors the category's type. Prices, manufacture dates and
// stock live on its batches (batch.model.js), and serialized products also have one SerialUnit per physical item.
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
    gstPercent: { type: Number, min: 0, max: 100, default: 18 }, // GST rate for invoices and proposals
    warrantyMonths: { type: Number, min: 0, max: 720, default: 0 }, // counted from the install date (SerialUnit)
    reorderLevel: { type: Number, min: 0, default: 0 }, // stock at or below this is flagged as low
    isSerialized: { type: Boolean, default: false }, // tracked per physical unit (panels, inverters, batteries), else per batch
    description: text(1000),
    attributes: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }, // { [category attribute key]: value }
    // PDFs kept with the product (datasheet, warranty card, manual…): uploaded and removed through their own endpoints
    documents: [
      new mongoose.Schema(
        {
          name: text(200),
          url: { type: String, required: true }, // /uploads/<companyId>-proddoc-<productId>-….pdf (protected)
          size: { type: Number, min: 0 },
          uploadedAt: { type: Date, default: Date.now },
        },
        subSchemaOptions,
      ),
    ],

    // typed fields the designer reads (and filters on), kept out of `attributes`
    // type 'panels'
    watts: { type: Number, min: [1, 'Watt must be greater than 0'], max: 2000 },
    length: { type: Number, min: 0.2, max: 5 }, // metres
    width: { type: Number, min: 0.2, max: 5 },
    // type 'poles'
    shape: { type: String, enum: PILLAR_SHAPES },
  },
  { ...schemaOptions, minimize: false },
);
productSchema.index({ company: 1, category: 1, watts: 1 });

export const Product = mongoose.model('Product', productSchema);

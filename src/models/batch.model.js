import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

const ObjectId = mongoose.Schema.Types.ObjectId;
const price = (label, required = true) => ({
  type: Number,
  min: [0, `${label} cannot be negative`],
  ...(required ? { required: [true, `${label} is required`] } : { default: 0 }),
});

/**
 * One stock receipt of a product: how many came in, how many are left, and its own prices. Stock is taken from the
 * oldest batch first (FIFO, see services/stock.service.js); `qtyRemaining` only changes through atomic updates.
 */
const batchSchema = new mongoose.Schema(
  {
    company: { type: ObjectId, ref: 'Company', required: true, index: true },
    product: { type: ObjectId, ref: 'Product', required: true },
    supplier: { type: ObjectId, ref: 'Supplier', required: [true, 'Supplier is required'] },
    batchNo: text(60),
    mfgDate: { type: Date, default: null },
    mfgYear: { type: Number, min: 1990, max: 2100, default: null }, // when only the year is known
    receivedDate: { type: Date, default: Date.now },
    qtyReceived: { type: Number, required: true, min: [0, 'Quantity cannot be negative'] },
    qtyRemaining: { type: Number, required: true, min: [0, 'Remaining quantity cannot be negative'] },
    purchasePrice: price('Purchase price', false),
    basePrice: price('Base price'),
    wholesalePrice: price('Wholesale price'),
    retailPrice: price('Retail price'),
    note: text(300),
    billUrl: { type: String, default: '' }, // the supplier's bill (PDF or image), /uploads/<file>; kept private
    billName: text(200),
  },
  schemaOptions,
);
batchSchema.index({ product: 1, receivedDate: 1 }); // FIFO lookups
batchSchema.pre('validate', function checkRemaining() {
  if (this.qtyRemaining > this.qtyReceived) this.invalidate('qtyRemaining', 'Remaining quantity cannot be more than the quantity received');
});

export const Batch = mongoose.model('Batch', batchSchema);

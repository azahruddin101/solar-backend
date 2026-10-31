import mongoose from 'mongoose';
import { UNIT_STATUS } from '../constants/index.js';
import { schemaOptions } from './schemaOptions.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

/** installDate + warrantyMonths, clamped to the month's last day (31 Jan + 1 month → 28/29 Feb). null when not installed. */
export function warrantyEndDate(installDate, warrantyMonths) {
  if (!installDate) return null;
  const start = new Date(installDate);
  if (Number.isNaN(start.getTime())) return null;
  const months = Math.max(0, Number(warrantyMonths) || 0);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1, start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return end;
}

// One physical item of a serialized product (a panel, an inverter, a battery), received in a batch. Named SerialUnit
// because "unit" already means the unit of measure (Piece, Nos…) elsewhere in the app.
const serialUnitSchema = new mongoose.Schema(
  {
    company: { type: ObjectId, ref: 'Company', required: true },
    product: { type: ObjectId, ref: 'Product', required: true },
    batch: { type: ObjectId, ref: 'Batch', required: true, index: true },
    serialNo: { type: String, required: [true, 'Serial number is required'], trim: true, maxlength: 80 },
    status: { type: String, enum: UNIT_STATUS, default: 'inStock' },
    soldInvoice: { type: ObjectId, ref: 'Invoice', default: null },
    soldEwayBill: { type: ObjectId, ref: 'EwayBill', default: null }, // the e-way bill it left stock on (the invoice follows later)
    installedProject: { type: ObjectId, ref: 'Project', default: null }, // the installation (site) it went to
    installDate: { type: Date, default: null },
  },
  schemaOptions,
);
serialUnitSchema.index({ company: 1, serialNo: 1 }, { unique: true });
serialUnitSchema.index({ company: 1, product: 1, status: 1 });

/** Needs `product` populated (with warrantyMonths); warranty runs from the install date, not the sale. */
serialUnitSchema.virtual('warrantyEnd').get(function warrantyEnd() {
  const months = this.product?.warrantyMonths;
  return months === undefined ? null : warrantyEndDate(this.installDate, months);
});

export const SerialUnit = mongoose.model('SerialUnit', serialUnitSchema);

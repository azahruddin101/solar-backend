import mongoose from 'mongoose';
import { STAFF_PERMISSIONS } from '../constants/index.js';
import { PERMISSIONS_VERSION } from '../constants/permissions.js';
import { schemaOptions, text } from './schemaOptions.js';

/**
 * A named set of staff permissions the company owner defines once and gives to several people ("Accountant",
 * "Telecaller"). A staff member's access is the union of their roles plus any extra grants on their own account.
 */
const roleSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: text(200),
    permissions: { type: [{ type: String, enum: STAFF_PERMISSIONS }], default: () => [] },
    permissionsVersion: { type: Number, default: PERMISSIONS_VERSION }, // names of `permissions`; older roles are migrated once
  },
  schemaOptions,
);
roleSchema.index({ company: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export const Role = mongoose.model('Role', roleSchema);

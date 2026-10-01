import mongoose from 'mongoose';
import { ROLES, STAFF_PERMISSIONS } from '../constants/index.js';
import { schemaOptions, text } from './schemaOptions.js';

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 200 },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: Object.values(ROLES), required: true },
    name: text(120),
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null, index: true }, // for role 'client': the client record this login belongs to
    // agents (field staff) — managed by their company
    phone: text(40),
    jobTitle: text(80), // legacy single role; prefer `roles`
    roles: { type: [{ type: String, trim: true, maxlength: 40 }], default: () => [] },
    // company workspace areas this staff member may open beyond their own assigned steps (role 'agent' only)
    permissions: { type: [{ type: String, enum: STAFF_PERMISSIONS }], default: () => [] },
    photo: text(300), // /uploads/… portrait (optional)
    active: { type: Boolean, default: true }, // an inactive agent cannot sign in
    lastLoginAt: Date,
    tokenVersion: { type: Number, default: 0 }, // bumped when the password changes: every older sign-in token stops working
  },
  schemaOptions,
);

export const User = mongoose.model('User', userSchema);

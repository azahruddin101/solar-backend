import mongoose from 'mongoose';
import { ROLES } from '../constants/index.js';
import { schemaOptions, text } from './schemaOptions.js';

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 200 },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: Object.values(ROLES), required: true },
    name: text(120),
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null, index: true },
    lastLoginAt: Date,
  },
  schemaOptions,
);

export const User = mongoose.model('User', userSchema);

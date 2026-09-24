import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

/** Active sign-in sessions for enforcing concurrent device limits per company. */
const authSessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true, default: null },
    sessionId: { type: String, required: true, unique: true, index: true },
    userAgent: text(300),
    lastActiveAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  schemaOptions,
);

authSessionSchema.index({ company: 1, lastActiveAt: 1 });
// MongoDB removes a session document once its expiry time has passed (covers admin and impersonation sessions too)
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthSession = mongoose.model('AuthSession', authSessionSchema);

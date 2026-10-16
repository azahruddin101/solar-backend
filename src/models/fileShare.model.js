import mongoose from 'mongoose';
import { schemaOptions } from './schemaOptions.js';

/** Short public link to a protected billing PDF (invoice / receipt) in uploads or S3. */
const fileShareSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    pdfName: { type: String, required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    expiresAt: { type: Date, required: true },
  },
  schemaOptions,
);

fileShareSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const FileShare = mongoose.model('FileShare', fileShareSchema);

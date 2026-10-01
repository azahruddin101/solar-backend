import mongoose from 'mongoose';
import { schemaOptions, text } from './schemaOptions.js';

/** A snapshot taken each time a design's quotation PDF is downloaded, so previous versions stay traceable. */
const designVersionSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    design: { type: mongoose.Schema.Types.ObjectId, ref: 'Design', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    pdfName: text(200), // stored file name, served at /uploads/<pdfName>
    data: { type: mongoose.Schema.Types.Mixed, default: null }, // snapshot of Design.data at download time
    summary: { type: mongoose.Schema.Types.Mixed, default: null }, // snapshot of Design.summary at download time
  },
  { ...schemaOptions, minimize: false },
);

designVersionSchema.index({ design: 1, createdAt: -1 });

export const DesignVersion = mongoose.model('DesignVersion', designVersionSchema);

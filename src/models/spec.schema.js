import mongoose from 'mongoose';

/** A free-form product detail, e.g. { key: 'Efficiency', value: '21.3 %' }. Embedded without its own id. */
export const specSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 60 },
    value: { type: String, trim: true, maxlength: 200, default: '' },
  },
  { _id: false },
);

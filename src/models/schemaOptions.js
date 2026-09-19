// Shared schema options. API shape: `id` instead of `_id`, no `__v`, never the password hash.
export const schemaOptions = {
  timestamps: true,
  toJSON: {
    virtuals: true,
    versionKey: false,
    transform: (doc, ret) => {
      delete ret._id;
      delete ret.passwordHash;
      return ret;
    },
  },
};

export const text = (max = 200, extra = {}) => ({ type: String, trim: true, maxlength: max, default: '', ...extra });

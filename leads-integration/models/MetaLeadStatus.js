const mongoose = require('mongoose');

const STATUS_COLORS = ['slate', 'blue', 'amber', 'emerald', 'rose', 'purple', 'cyan'];

// Lead statuses the admin defines for the Meta lead pipeline (e.g. Interested -> Callback -> Registered)
const metaLeadStatusSchema = mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Lower-cased name, used to keep names unique
    nameKey: {
      type: String,
      required: true,
    },
    color: {
      type: String,
      enum: STATUS_COLORS,
      default: 'slate',
    },
    // Position in the pipeline (lower comes first)
    order: {
      type: Number,
      default: 0,
    },
    // 'converted' = the lead became a client, 'lost' = the lead is closed without one, 'open' = still being worked.
    // Every company has exactly one converted and one lost status (see controllers/metaAssignmentController.js).
    outcome: {
      type: String,
      enum: ['open', 'converted', 'lost'],
      default: 'open',
    },
    // Leads in this status count as converted in the performance report (kept equal to outcome === 'converted')
    isConversion: {
      type: Boolean,
      default: false,
    },
    // Choosing this status on a lead asks for a date (a callback, a site visit…), so the lead can be found under "upcoming"
    requiresDate: {
      type: Boolean,
      default: false,
    },
    // Inactive statuses stay on existing leads but can no longer be chosen
    isActive: {
      type: Boolean,
      default: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// A name can be reused once the old status has been deleted
metaLeadStatusSchema.index(
  { company: 1, nameKey: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

const MetaLeadStatus = mongoose.model('MetaLeadStatus', metaLeadStatusSchema);

module.exports = MetaLeadStatus;
module.exports.STATUS_COLORS = STATUS_COLORS;

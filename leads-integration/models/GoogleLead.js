const mongoose = require('mongoose');

// A lead captured by a Google Ads lead form extension (delivered to the webhook).
// Stored apart from Meta leads. Same idea as MetaLead: answers, campaign details, the
// telecaller it is assigned to and the admin-defined status.
const googleLeadSchema = mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    // Google Ads lead_id (idempotency: one lead is stored once)
    externalLeadId: { type: String, required: true },
    formId: { type: String, default: '' },
    campaignId: { type: String, default: '' },
    adGroupId: { type: String, default: '' },
    creativeId: { type: String, default: '' },
    gclId: { type: String, default: '' },
    isTest: { type: Boolean, default: false },

    fullName: { type: String, default: '' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    // Lower-cased answers used by the server-side search
    searchText: { type: String, default: '' },
    // Answers keyed by Google's column id (or question text for custom questions)
    fields: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Payload as received, without the webhook key
    rawData: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Counsellor who owns the lead
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedAt: { type: Date },

    // Current status (from the shared lead-status list) and its history
    status: { type: mongoose.Schema.Types.ObjectId, ref: 'MetaLeadStatus', default: null },
    statusName: { type: String, default: '' },
    statusColor: { type: String, default: 'slate' },
    statusUpdatedAt: { type: Date },
    scheduledAt: { type: Date, default: null }, // the date the current status booked (callback, visit…)
    previousSchedules: { type: [{ scheduledAt: { type: Date }, statusName: { type: String, default: '' }, replacedAt: { type: Date, default: Date.now }, byName: { type: String, default: '' } }], default: [] }, // dates this lead had before, oldest first
    rescheduledCount: { type: Number, default: 0 },
    // every person who has held this lead, oldest first (endedAt null = holds it now); a hand-over sets isReassigned
    assignmentHistory: { type: [{ assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, assigneeName: { type: String, default: '' }, assignedAt: { type: Date }, endedAt: { type: Date, default: null }, byName: { type: String, default: '' } }], default: [] },
    isReassigned: { type: Boolean, default: false },
    reassignedCount: { type: Number, default: 0 },
    isRescheduled: { type: Boolean, default: false },
    // what happened on this lead (assignments, hand-overs); status changes live in statusHistory
    logs: { type: [{ action: { type: String, required: true }, message: { type: String, default: '' }, byName: { type: String, default: '' }, at: { type: Date, default: Date.now } }], default: [] },
    statusHistory: {
      type: [
        {
          status: { type: mongoose.Schema.Types.ObjectId, ref: 'MetaLeadStatus', required: true },
          statusName: { type: String, required: true },
          statusColor: { type: String, default: 'slate' },
          remark: { type: String, default: '' },
          scheduledAt: { type: Date, default: null },
          rescheduled: { type: Boolean, default: false }, // this change moved an earlier date
          changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          changedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    // Flag staff set on leads that need attention first.
    isPriority: { type: Boolean, default: false },

    isDeleted: { type: Boolean, default: false },
    // set when the lead was converted into a client (from the lead's details, after choosing the converted status)
    convertedClient: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    convertedClientName: { type: String, default: '' },
    convertedAt: { type: Date },
    convertedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

googleLeadSchema.index({ company: 1, externalLeadId: 1 }, { unique: true });
googleLeadSchema.index({ isDeleted: 1, createdAt: -1 });
googleLeadSchema.index({ assignedTo: 1, createdAt: -1 });
googleLeadSchema.index({ status: 1 });

require('../services/leadSheetHooks').attachLeadSheetHooks(googleLeadSchema);

const GoogleLead = mongoose.model('GoogleLead', googleLeadSchema);

module.exports = GoogleLead;

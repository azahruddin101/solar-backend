const mongoose = require('mongoose');

const metaLeadSchema = mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    source: {
      type: String,
      required: true,
      enum: ['META'],
      default: 'META',
    },
    // Meta leadgen ID
    externalLeadId: {
      type: String,
      required: true,
    },
    pageId: {
      type: String,
      required: true,
    },
    pageName: {
      type: String,
      default: '',
    },
    formId: {
      type: String,
      required: true,
    },
    formName: {
      type: String,
      default: '',
    },
    campaignId: String,
    campaignName: String,
    adSetId: String,
    adSetName: String,
    adId: String,
    adName: String,
    platform: String,
    isOrganic: Boolean,

    // Best-effort copies of common answers, only set when the form asks for them
    fullName: {
      type: String,
      default: '',
    },
    email: {
      type: String,
      default: '',
    },
    phone: {
      type: String,
      default: '',
    },
    // Lower-cased answers used by the server-side search
    searchText: {
      type: String,
      default: '',
    },

    // Answers keyed by the form's own question keys - differs per form
    fields: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Lead exactly as returned by the Graph API
    rawData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // When the lead was submitted on Meta
    leadCreatedAt: {
      type: Date,
    },

    // Processing queue state (webhook -> pending -> worker -> processed / failed)
    processingStatus: {
      type: String,
      required: true,
      enum: ['pending', 'processing', 'processed', 'failed'],
      default: 'pending',
    },
    attempts: {
      type: Number,
      default: 0,
    },
    nextAttemptAt: {
      type: Date,
      default: Date.now,
    },
    lockedAt: {
      type: Date,
    },
    lastError: {
      type: String,
    },
    processedAt: {
      type: Date,
    },

    // CRM lead created when this Meta lead is marked registered, so the same form can open
    crmLead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
    },

    // Telecaller who currently owns the lead (their work is tracked in MetaLeadAssignment)
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    assignedAt: {
      type: Date,
    },

    // Status set by an admin before the lead is assigned. The counsellor's own track takes over
    // once they (or an admin) update the status on the active assignment.
    adminStatus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MetaLeadStatus',
      default: null,
    },
    adminStatusHistory: {
      type: [
        {
          status: { type: mongoose.Schema.Types.ObjectId, ref: 'MetaLeadStatus', required: true },
          statusName: { type: String, required: true },
          statusColor: { type: String, default: 'slate' },
          remark: { type: String, default: '' },
          changedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    adminStatusUpdatedAt: {
      type: Date,
    },

    // Flag staff set on leads that need attention first.
    isPriority: {
      type: Boolean,
      default: false,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },

    // set when the lead was converted into a client (from the lead's details, after choosing the converted status)
    convertedClient: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    convertedClientName: { type: String, default: '' },
    convertedAt: { type: Date },
    convertedByName: { type: String, default: '' },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

// Idempotency: a Meta lead can only ever be stored once
metaLeadSchema.index({ company: 1, source: 1, externalLeadId: 1 }, { unique: true });
// Worker queue lookup
metaLeadSchema.index({ processingStatus: 1, nextAttemptAt: 1 });
// Lead list
metaLeadSchema.index({ processingStatus: 1, leadCreatedAt: -1 });
metaLeadSchema.index({ formId: 1, leadCreatedAt: -1 });
metaLeadSchema.index({ assignedTo: 1, leadCreatedAt: -1 });

require('../services/leadSheetHooks').attachLeadSheetHooks(metaLeadSchema);

const MetaLead = mongoose.model('MetaLead', metaLeadSchema);

module.exports = MetaLead;

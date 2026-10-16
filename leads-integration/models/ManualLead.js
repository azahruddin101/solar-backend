const mongoose = require('mongoose');

// A lead added by hand in the CRM ("Add lead") or imported from a CSV / Excel sheet. Name, Phone and Address are on
// every company's form; the answers to the company's own fields (utils/leadForm.js) are kept in `fields` by key.
// Same pipeline as Meta and Google leads: shared statuses, assignment, priority.
const manualLeadSchema = mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    // 'manual' = typed in on the form, 'import' = from a spreadsheet
    source: { type: String, enum: ['manual', 'import'], default: 'manual' },

    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    // the phone's last 10 digits: "+91 98765 43210" and "9876543210" are the same person (duplicate check)
    phoneKey: { type: String, default: '' },
    address: { type: String, default: '', maxlength: 2000 },
    fields: { type: mongoose.Schema.Types.Mixed, default: {} },
    // lower-cased text of every answer, for the search box
    searchText: { type: String, default: '' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, default: '' },

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedAt: { type: Date },

    status: { type: mongoose.Schema.Types.ObjectId, ref: 'MetaLeadStatus', default: null },
    statusName: { type: String, default: '' },
    statusColor: { type: String, default: 'slate' },
    statusUpdatedAt: { type: Date },
    statusHistory: {
      type: [
        {
          status: { type: mongoose.Schema.Types.ObjectId, ref: 'MetaLeadStatus', required: true },
          statusName: { type: String, required: true },
          statusColor: { type: String, default: 'slate' },
          remark: { type: String, default: '' },
          changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          changedByName: { type: String, default: '' },
          changedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    isPriority: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
    // set when the lead was converted into a client (from the lead's details, after choosing the converted status)
    convertedClient: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    convertedClientName: { type: String, default: '' },
    convertedAt: { type: Date },
    convertedByName: { type: String, default: '' },
  },
  { timestamps: true, collection: 'manualleads' }
);

manualLeadSchema.index({ company: 1, isDeleted: 1, createdAt: -1 });
manualLeadSchema.index({ company: 1, phoneKey: 1 });
manualLeadSchema.index({ company: 1, assignedTo: 1, createdAt: -1 });

// keep the company's Google Sheet up to date
require('../services/leadSheetHooks').attachLeadSheetHooks(manualLeadSchema);

module.exports = mongoose.models.ManualLead || mongoose.model('ManualLead', manualLeadSchema);

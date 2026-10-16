const mongoose = require('mongoose');

// One company's Google Sheet. The company adds a small Apps Script (with the secret below) to its own sheet,
// publishes it as a web app and pastes the web app address here; the CRM then rewrites the sheet's "Leads" tab
// whenever that company's leads change. Every company has its own sheet, secret and address.
const sheetIntegrationSchema = mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
    // Shared with the script so only this CRM can write to the sheet (AES-256-GCM encrypted)
    secretEncrypted: { type: String, required: true },
    // https://script.google.com/macros/s/…/exec — empty until the company connects
    webAppUrl: { type: String, default: '' },
    connectedAt: { type: Date, default: null },
    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastSyncAt: { type: Date, default: null },
    lastSyncCount: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
    lastErrorAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.SheetIntegration || mongoose.model('SheetIntegration', sheetIntegrationSchema);

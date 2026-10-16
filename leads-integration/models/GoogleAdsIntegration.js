const mongoose = require('mongoose');

// Google Ads webhook key per company (tenant).
const googleAdsIntegrationSchema = mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
    webhookKeyEncrypted: { type: String, default: '' },
    keyCreatedAt: { type: Date },
    keyCreatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

googleAdsIntegrationSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.webhookKeyEncrypted;
    return ret;
  },
});

const GoogleAdsIntegration = mongoose.model('GoogleAdsIntegration', googleAdsIntegrationSchema);

module.exports = GoogleAdsIntegration;

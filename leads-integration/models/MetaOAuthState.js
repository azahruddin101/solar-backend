const mongoose = require('mongoose');

// Single-use OAuth state issued when a user starts the Meta connect flow (CSRF protection)
const metaOAuthStateSchema = mongoose.Schema(
  {
    // SHA-256 of the state value sent to Meta
    stateHash: {
      type: String,
      required: true,
      unique: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    // CRM page the browser goes back to after Facebook Login (checked against the allowed CRM origins)
    returnTo: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// Expired states are removed automatically by MongoDB
metaOAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const MetaOAuthState = mongoose.model('MetaOAuthState', metaOAuthStateSchema);

module.exports = MetaOAuthState;

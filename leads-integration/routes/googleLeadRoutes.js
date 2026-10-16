const express = require('express');
const multer = require('multer');
const router = express.Router();
const { getGoogleAdsStatus } = require('../controllers/googleLeadController');
const {
  getGoogleAdsIntegration,
  createGoogleAdsKey,
  deleteGoogleAdsKey,
  importGoogleAdsLeads,
} = require('../controllers/googleAdsIntegrationController');
const { protect, authorize } = require('../middleware/auth');
const { META_ALLOWED_ROLES } = require('../config/meta');
const { bindLeadsTenant } = require('../middleware/tenant');

// The Google Ads lead form webhook (POST /webhook) is public and mounted in backend/src/app.js:
// it is authenticated by the google_key in the payload, not by a user login.

// Google Ads integration (owner). Working on the leads themselves is in backend/src/routes/leads.routes.js.
const managers = [protect, authorize(...META_ALLOWED_ROLES), bindLeadsTenant];
router.get('/status', managers, getGoogleAdsStatus);

// Integrations > Google Ads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    if (name.endsWith('.csv') || name.endsWith('.xlsx') || name.endsWith('.xls')) {
      cb(null, true);
      return;
    }
    cb(new Error('Upload the CSV or Excel file downloaded from Google Ads'));
  },
});
const uploadLeadFile = (req, res, next) => {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'The file must be 5 MB or smaller' : error.message;
    res.status(400).json({ message });
  });
};
router.get('/integration', managers, getGoogleAdsIntegration);
router.post('/integration/key', managers, createGoogleAdsKey);
router.delete('/integration/key', managers, deleteGoogleAdsKey);
router.post('/import', managers, uploadLeadFile, importGoogleAdsLeads);

module.exports = router;

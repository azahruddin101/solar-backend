const express = require('express');
const router = express.Router();
const { getSheet, connectSheet, syncSheetNow, newSheetSecret, disconnectSheet } = require('../controllers/sheetController');
const { protect, authorize } = require('../middleware/auth');
const { META_ALLOWED_ROLES } = require('../config/meta');
const { bindLeadsTenant } = require('../middleware/tenant');

// Lead integrations > Google Sheet: the company owner connects the company's own sheet.
router.use(protect, authorize(...META_ALLOWED_ROLES), bindLeadsTenant);

router.route('/')
  .get(getSheet)
  .put(connectSheet)
  .delete(disconnectSheet);
router.post('/sync', syncSheetNow);
router.post('/secret', newSheetSecret);

module.exports = router;

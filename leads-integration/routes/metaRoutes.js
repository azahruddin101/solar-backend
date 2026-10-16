const express = require('express');
const router = express.Router();
const {
  saveMetaAppSettings,
  getMetaStatus,
  startMetaConnect,
  getMetaPages,
  getMetaPageForms,
  connectMetaForms,
  disconnectMeta,
  retryFailedMetaLeads,
} = require('../controllers/metaController');
const { startMetaSync, getMetaSyncStatus } = require('../controllers/metaSyncController');
const { protect, authorize } = require('../middleware/auth');
const { META_ALLOWED_ROLES } = require('../config/meta');
const { loadMetaSettings } = require('../utils/metaSettings');
const { bindLeadsTenant } = require('../middleware/tenant');

// The OAuth callback (GET /callback) is public and mounted in backend/src/app.js, not here:
// everything under this router requires a signed-in company owner.

// Lead statuses (owner-managed master). Working on the leads themselves is in backend/src/routes/leads.routes.js.
router.use(require('./metaAssignmentRoutes'));

router.use(protect, authorize(...META_ALLOWED_ROLES), bindLeadsTenant, loadMetaSettings);

router.get('/status', getMetaStatus);
router.put('/app-settings', saveMetaAppSettings);
router.get('/connect', startMetaConnect);
router.get('/pages', getMetaPages);

router.route('/pages/:pageId/forms')
  .get(getMetaPageForms)
  .post(connectMetaForms);

router.post('/leads/retry-failed', retryFailedMetaLeads);

// Historical sync ("Sync Previous Leads")
router.post('/sync', startMetaSync);
router.get('/sync/status', getMetaSyncStatus);

router.delete('/', disconnectMeta);

module.exports = router;

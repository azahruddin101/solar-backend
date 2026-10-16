const express = require('express');
const router = express.Router();
const {
  getLeadStatuses,
  createLeadStatus,
  updateLeadStatus,
  reorderLeadStatuses,
  deleteLeadStatus,
} = require('../controllers/metaAssignmentController');
const { protect, authorize } = require('../middleware/auth');
const { META_ALLOWED_ROLES } = require('../config/meta');
const { bindLeadsTenant } = require('../middleware/tenant');

// Lead statuses: a company master, managed by the owner. Mounted under /api/company/integrations/meta.
// Working on leads (lists, status, priority, assignment, reports, export) lives in backend/src/routes/leads.routes.js,
// which checks the staff member's Leads permissions.
const managers = [protect, authorize(...META_ALLOWED_ROLES), bindLeadsTenant];

router.get('/lead-statuses', managers, getLeadStatuses);
router.post('/lead-statuses', managers, createLeadStatus);
router.put('/lead-statuses/reorder', managers, reorderLeadStatuses);
router.put('/lead-statuses/:id', managers, updateLeadStatus);
router.delete('/lead-statuses/:id', managers, deleteLeadStatus);

module.exports = router;

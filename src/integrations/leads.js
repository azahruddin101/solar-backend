// Loads the CommonJS leads-integration submodule (ported from IIAE).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../leads-integration');

export const metaWebhookRoutes = require(path.join(root, 'routes/metaWebhookRoutes.js'));
export const metaRoutes = require(path.join(root, 'routes/metaRoutes.js'));
export const googleLeadRoutes = require(path.join(root, 'routes/googleLeadRoutes.js'));
export const sheetRoutes = require(path.join(root, 'routes/sheetRoutes.js'));
// Public endpoints (no Bearer token): the Meta OAuth browser redirect, validated with the single-use OAuth
// state, and the Google Ads lead webhook, authenticated by the per-company google_key in the payload.
// They are mounted in app.js, outside the signed-in /api/company router.
export const { handleMetaCallback } = require(path.join(root, 'controllers/metaController.js'));
export const { receiveGoogleAdsLead } = require(path.join(root, 'controllers/googleLeadController.js'));

// Working on leads (lists, status, priority, assignment, reports, export) — wired up with the Leads permissions in
// routes/leads.routes.js.
const metaAssign = require(path.join(root, 'controllers/metaAssignmentController.js'));
const meta = require(path.join(root, 'controllers/metaController.js'));
const google = require(path.join(root, 'controllers/googleLeadController.js'));
const { setLeadPriority } = require(path.join(root, 'utils/leadPriority.js'));
export const leadHandlers = {
  statuses: metaAssign.getLeadStatuses,
  metaList: meta.getMetaLeads,
  metaFilters: meta.getMetaLeadFilters,
  metaAssignments: metaAssign.getMetaLeadAssignments,
  metaStatus: metaAssign.updateMetaLeadStatus,
  metaAssign: metaAssign.assignMetaLeads,
  metaPriority: setLeadPriority(require(path.join(root, 'models/MetaLead.js'))),
  googleList: google.listGoogleLeads,
  googleStatus: google.updateGoogleLeadStatus,
  googleAssign: google.assignGoogleLeads,
  googlePriority: setLeadPriority(require(path.join(root, 'models/GoogleLead.js'))),
  report: metaAssign.getTelecallerReport,
  reportTasks: metaAssign.getTelecallerTasks,
  exportLeads: require(path.join(root, 'controllers/leadExportController.js')).exportLeads,
  manual: require(path.join(root, 'controllers/manualLeadController.js')),
  manualPriority: setLeadPriority(require(path.join(root, 'models/ManualLead.js'))),
};
export const { bindLeadsTenant } = require(path.join(root, 'middleware/tenant.js'));
export const leadForm = require(path.join(root, 'utils/leadForm.js'));
export const leadModels = {
  meta: require(path.join(root, 'models/MetaLead.js')),
  google: require(path.join(root, 'models/GoogleLead.js')),
  manual: require(path.join(root, 'models/ManualLead.js')),
  status: require(path.join(root, 'models/MetaLeadStatus.js')),
};
export const leadAssignmentModel = require(path.join(root, 'models/MetaLeadAssignment.js'));

export function startLeadIntegrationWorkers() {
  require(path.join(root, 'workers/metaLeadWorker.js')).startMetaLeadWorker();
  // bring each connected company's Google Sheet up to date
  require(path.join(root, 'services/googleSheetSync.js')).scheduleAllSheets()
    .catch((e) => console.error('[leads] Could not schedule Google Sheet sync:', e.message));
}

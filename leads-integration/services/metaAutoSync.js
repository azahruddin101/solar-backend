// Automatic Meta lead sync: every few hours (META_AUTO_SYNC_HOURS, default 3) each company with a working Meta
// connection gets a sync job of its connected lead forms - the same job as "Sync Previous Leads", run by the same
// worker (workers/metaSyncWorker.js). It is a safety net next to the real-time webhook: leads the webhook missed
// (downtime, a delivery Meta dropped, a page subscription that lapsed) are picked up within one interval.
//
// Why a "due" check instead of a fixed clock timer:
//  - every server start would reset a plain 3-hour timer (a deploy every 2 hours would mean it never runs), so the
//    schedule lives in the database: a short tick asks "whose last sync is older than the interval?";
//  - with several server processes, each company's run is claimed with one atomic update, so only one process
//    queues it; the job's unique activeKey also stops it from overlapping a sync that is already running.
// Each run only reads leads submitted since the last fully successful sync (with an overlap), not all 90 days.
const mongoose = require('mongoose');
const MetaIntegration = require('../models/MetaIntegration');
const MetaSyncJob = require('../models/MetaSyncJob');
const { kickMetaSyncWorker } = require('../workers/metaLeadWorker');
const { logMetaEvent, logMetaError } = require('../utils/metaLogger');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Tunable so tests run without waiting. hours <= 0 turns the automatic sync off.
const AUTO_SYNC_SETTINGS = {
  intervalMs: (() => {
    const raw = process.env.META_AUTO_SYNC_HOURS;
    const hours = raw === undefined || raw === '' ? 3 : Number(raw);
    return Number.isFinite(hours) && hours > 0 ? hours * HOUR : 0;
  })(),
  // How often the "who is due?" check runs. Cheap: one indexed query when nobody is due.
  tickMs: 5 * 60 * 1000,
  // Re-read this much before the last successful sync, so a lead submitted while it ran is never missed
  // (duplicates are skipped by the unique lead key).
  overlapMs: HOUR,
  // Meta only keeps leads for 90 days: an older starting point means "read everything".
  retentionMs: 90 * DAY,
};

let timer = null;
let ticking = false;

const activeKeyFor = (companyId) => `active:${companyId}`;
const sameForms = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

/** Companies whose Meta connection can be synced: connected, not waiting for a reconnect, a Page and forms chosen. */
const syncableIntegrations = () => MetaIntegration.find({
  connected: true,
  needsReconnect: { $ne: true },
  selectedPageId: { $nin: [null, ''] },
  'forms.0': { $exists: true },
  'appSettings.appId': { $nin: [null, ''] },
  'appSettings.appSecretEncrypted': { $nin: [null, ''] },
}).select('company selectedPageId pages.pageId pages.pageName forms autoSyncQueuedAt').lean();

/** Only active companies (and organizations) are synced: a suspended company's leads wait until it is active again. */
async function activeCompanyIds(companyIds) {
  const Company = mongoose.models.Company;
  const Organization = mongoose.models.Organization;
  if (!Company) return new Set(companyIds.map(String)); // the leads module running on its own
  const companies = await Company.find({ _id: { $in: companyIds }, status: 'active' }).select('organization').lean();
  const orgIds = companies.map((c) => c.organization).filter(Boolean);
  const activeOrgs = Organization && orgIds.length
    ? new Set((await Organization.find({ _id: { $in: orgIds }, status: 'active' }).select('_id').lean()).map((o) => String(o._id)))
    : null;
  return new Set(companies.filter((c) => !c.organization || !activeOrgs || activeOrgs.has(String(c.organization))).map((c) => String(c._id)));
}

/**
 * Where this run starts reading: just before the last sync that finished every form (and covered the same forms),
 * or null - every lead Meta still keeps - when there was none, the forms changed, or it is older than Meta keeps leads.
 */
async function startingPoint(companyId, formIds, now) {
  const last = await MetaSyncJob.findOne({ company: companyId, status: 'completed', formsFailed: 0 })
    .sort({ startedAt: -1 })
    .select('startedAt since forms.formId')
    .lean();
  if (!last?.startedAt) return null;
  if (!sameForms(last.forms.map((f) => f.formId), formIds)) return null; // a new form: read its whole history once
  const since = new Date(last.startedAt.getTime() - AUTO_SYNC_SETTINGS.overlapMs);
  return now - since > AUTO_SYNC_SETTINGS.retentionMs ? null : since;
}

/** Queues one scheduled sync for a company, unless another process claimed this run or a sync is already going. */
async function queueCompany(integration, now) {
  const companyId = integration.company;
  const due = new Date(now.getTime() - AUTO_SYNC_SETTINGS.intervalMs);

  // A sync that anyone started within the interval counts: the next scheduled one comes an interval after it
  const recent = await MetaSyncJob.exists({ company: companyId, createdAt: { $gt: due } });
  if (recent) return 'recent';

  // Claim this run: of several processes ticking at once, exactly one gets past this update
  const claimed = await MetaIntegration.findOneAndUpdate(
    { _id: integration._id, $or: [{ autoSyncQueuedAt: null }, { autoSyncQueuedAt: { $lte: due } }] },
    { $set: { autoSyncQueuedAt: now } },
    { new: true, projection: { _id: 1 } },
  );
  if (!claimed) return 'claimed-elsewhere';

  const page = integration.pages.find((p) => p.pageId === integration.selectedPageId);
  if (!page) return 'no-page';
  const formIds = integration.forms.map((f) => f.formId);
  const since = await startingPoint(companyId, formIds, now);

  try {
    await MetaSyncJob.create({
      company: companyId,
      activeKey: activeKeyFor(companyId),
      status: 'pending',
      trigger: 'scheduled',
      since,
      pageId: page.pageId,
      pageName: page.pageName,
      forms: integration.forms.map((f) => ({ formId: f.formId, formName: f.formName })),
      totalForms: integration.forms.length,
      nextAttemptAt: now,
    });
  } catch (error) {
    if (error.code === 11000) return 'running'; // a sync is already running for this company: it covers this run
    throw error;
  }
  logMetaEvent('META_AUTO_SYNC_QUEUED', { companyId: String(companyId), since: since ? since.toISOString() : 'all', forms: formIds.length });
  return 'queued';
}

/**
 * Queues a scheduled sync for every company that is due. Safe to call at any time and from several processes.
 * Returns how many syncs were queued.
 */
async function queueDueMetaSyncs(now = new Date()) {
  if (!AUTO_SYNC_SETTINGS.intervalMs) return 0;
  const integrations = await syncableIntegrations();
  if (!integrations.length) return 0;
  const active = await activeCompanyIds(integrations.map((i) => i.company));

  let queued = 0;
  for (const integration of integrations) {
    if (!active.has(String(integration.company))) continue;
    try {
      if ((await queueCompany(integration, now)) === 'queued') queued += 1;
    } catch (error) {
      // one company's problem never stops the others
      logMetaError('META_AUTO_SYNC_ERROR', { companyId: String(integration.company), reason: error.name });
    }
  }
  if (queued) kickMetaSyncWorker();
  return queued;
}

async function tick() {
  if (ticking || mongoose.connection.readyState !== 1) return;
  ticking = true;
  try {
    await queueDueMetaSyncs();
  } catch (error) {
    logMetaError('META_AUTO_SYNC_ERROR', { reason: error.name });
  } finally {
    ticking = false;
  }
}

/** Starts the automatic sync (no-op when turned off with META_AUTO_SYNC_HOURS=0, or when already started). */
function startMetaAutoSync() {
  if (timer || !AUTO_SYNC_SETTINGS.intervalMs) return false;
  timer = setInterval(tick, AUTO_SYNC_SETTINGS.tickMs);
  timer.unref();
  // first check shortly after start-up, out of the way of migrations and the boot burst
  setTimeout(tick, 60 * 1000).unref();
  return true;
}

function stopMetaAutoSync() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** When the next scheduled sync for a company is due (null when the automatic sync is off). */
async function nextAutoSyncAt(companyId) {
  if (!AUTO_SYNC_SETTINGS.intervalMs) return null;
  const last = await MetaSyncJob.findOne({ company: companyId }).sort({ createdAt: -1 }).select('createdAt').lean();
  return last ? new Date(last.createdAt.getTime() + AUTO_SYNC_SETTINGS.intervalMs) : new Date();
}

module.exports = {
  AUTO_SYNC_SETTINGS,
  queueDueMetaSyncs,
  startMetaAutoSync,
  stopMetaAutoSync,
  nextAutoSyncAt,
};

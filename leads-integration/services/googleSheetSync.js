// Mirrors each company's leads (Meta, Google Ads, manual) into that company's own Google Sheet.
// The sheet runs a small Apps Script web app (apps-script/CompanyLeadsSheet.gs) holding the company's secret; a few
// seconds after any of the company's leads change we POST its full lead list, and the script rewrites the "Leads" tab.
// Same columns as the lead export (utils/leadRows.js), except "Other answers". One company's leads never go to another company's sheet.
const mongoose = require('mongoose');
const SheetIntegration = require('../models/SheetIntegration');
const { collectLeadRows, safeCell } = require('../utils/leadRows');
const { decryptToken } = require('../utils/metaCrypto');

const DEBOUNCE_MS = 4000;
const REQUEST_TIMEOUT_MS = 60000;
// Apps Script web app addresses only: a consumer account, or a Google Workspace domain
const WEB_APP_URL = /^https:\/\/script\.google\.com\/(a\/macros\/[a-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]{20,200}\/exec$/;

const timers = new Map(); // companyId -> pending timer
const running = new Map(); // companyId -> current sync promise
const queued = new Set(); // companies whose leads changed during a sync

const isWebAppUrl = (value) => WEB_APP_URL.test(String(value || '').trim());

// Apps Script answers with a redirect to the script's output; fetch follows it.
const postToSheet = async (url, secret, values) => {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, values }),
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error('Google didn’t answer. Check the web app address and try again.');
  }
  const raw = await response.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    // Google answers with an HTML page when the deployment is missing or not open to everyone
    if (response.status === 403 || /<title>\s*Access denied/i.test(raw)) {
      throw new Error('Google says “Access denied”: the web app isn’t open to the CRM yet. In Apps Script open Deploy → Manage deployments → edit (pencil), set “Who has access” to “Anyone” (not “Only myself” or “Anyone with a Google account”), choose Version: New version and Deploy. With a Google Workspace (company) account, your admin may need to allow sharing outside the organisation.');
    }
    if (response.status === 404) {
      throw new Error('Google can’t find this web app. The deployment may have been archived, or the address is incomplete — copy the Web app URL again from Deploy → Manage deployments.');
    }
    throw new Error('Google returned a web page instead of the script’s answer. Make sure you copied the Web app URL (ending in /exec) and chose “Who has access: Anyone” when deploying.');
  }
  if (body && body.error === 'Wrong secret') throw new Error('The sheet’s script has a different secret. Copy the script from this page again, paste it over the old one and deploy a new version.');
  if (!response.ok || !body || body.ok !== true) throw new Error(`The sheet refused the update: ${(body && body.error) || `HTTP ${response.status}`}`);
  return body;
};

const companyDoc = (companyId) => mongoose.model('Company').findById(companyId).lean();

/** Rewrite one company's sheet now. Records the result on its integration. Returns { count } or throws. */
const syncCompany = async (companyId) => {
  const integration = await SheetIntegration.findOne({ company: companyId });
  if (!integration || !integration.webAppUrl) return { skipped: true };
  try {
    // same columns as the export, without the "Other answers" column
    const values = await collectLeadRows({ companyId, company: await companyDoc(companyId), otherAnswers: false });
    await postToSheet(integration.webAppUrl, decryptToken(integration.secretEncrypted), values.map((row) => row.map(safeCell)));
    integration.lastSyncAt = new Date();
    integration.lastSyncCount = values.length - 1;
    integration.lastError = '';
    integration.lastErrorAt = null;
    await integration.save();
    return { count: values.length - 1 };
  } catch (error) {
    integration.lastError = String(error.message || error).slice(0, 400);
    integration.lastErrorAt = new Date();
    await integration.save().catch(() => {});
    throw error;
  }
};

// One sync per company at a time; changes made while one runs trigger exactly one more.
const startSync = (companyId) => {
  if (running.has(companyId)) {
    queued.add(companyId);
    return running.get(companyId);
  }
  const job = syncCompany(companyId)
    .catch((error) => console.error(`[SHEETS] company ${companyId}: ${error.message}`))
    .finally(() => {
      running.delete(companyId);
      if (queued.delete(companyId)) startSync(companyId);
    });
  running.set(companyId, job);
  return job;
};

/** Called after a company's leads change: waits a few seconds so a bulk import sends one update, not hundreds. */
const scheduleLeadSheetSync = (companyId, { delayMs = DEBOUNCE_MS } = {}) => {
  if (process.env.NODE_ENV === 'test' || !companyId) return;
  const id = String(companyId);
  clearTimeout(timers.get(id));
  const timer = setTimeout(async () => {
    timers.delete(id);
    try {
      if (await SheetIntegration.exists({ company: id, webAppUrl: { $ne: '' } })) startSync(id);
    } catch (error) {
      console.error('[SHEETS]', error.message);
    }
  }, delayMs);
  if (timer.unref) timer.unref();
  timers.set(id, timer);
};

/** At start-up: bring every connected company's sheet up to date (spread out a little). */
const scheduleAllSheets = async () => {
  const rows = await SheetIntegration.find({ webAppUrl: { $ne: '' } }).select('company').lean();
  rows.forEach((row, i) => scheduleLeadSheetSync(row.company, { delayMs: 8000 + i * 2000 }));
};

module.exports = { isWebAppUrl, postToSheet, syncCompany, scheduleLeadSheetSync, scheduleAllSheets };

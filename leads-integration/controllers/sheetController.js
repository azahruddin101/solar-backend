const fs = require('fs');
const path = require('path');
const SheetIntegration = require('../models/SheetIntegration');
const { encryptToken, decryptToken, generateOAuthState } = require('../utils/metaCrypto');
const { isWebAppUrl, syncCompany } = require('../services/googleSheetSync');

// Lead integrations > Google Sheet (company owner). Each company connects its own sheet: it copies the script below
// (with its own secret) into the sheet, deploys it as a web app and pastes the web app address here.

const TEMPLATE = path.join(__dirname, '../../apps-script/CompanyLeadsSheet.gs');
const log = (event, details = {}) => console.log(`[SHEETS] ${event} ${JSON.stringify(details)}`);

/** The company's integration, created with a fresh secret the first time it is opened. */
const integrationFor = async (companyId) => {
  const found = await SheetIntegration.findOne({ company: companyId });
  if (found) return found;
  try {
    return await SheetIntegration.create({ company: companyId, secretEncrypted: encryptToken(generateOAuthState()) });
  } catch (error) {
    if (error.code === 11000) return SheetIntegration.findOne({ company: companyId }); // opened twice at once
    throw error;
  }
};

const view = (integration) => ({
  connected: Boolean(integration.webAppUrl),
  webAppUrl: integration.webAppUrl,
  connectedAt: integration.connectedAt,
  lastSyncAt: integration.lastSyncAt,
  lastSyncCount: integration.lastSyncCount,
  lastError: integration.lastError,
  lastErrorAt: integration.lastErrorAt,
  // the script to paste into the sheet, with this company's secret filled in
  script: fs.readFileSync(TEMPLATE, 'utf8').replace('{{SECRET}}', decryptToken(integration.secretEncrypted)),
});

const fail = (res, error, message) => {
  console.error(`[SHEETS] ${message}:`, error.message);
  res.status(500).json({ message });
};

// @route GET /api/company/integrations/sheet
const getSheet = async (req, res) => {
  try {
    res.json(view(await integrationFor(req.leadsCompanyId)));
  } catch (error) {
    fail(res, error, 'Server error loading the Google Sheet connection');
  }
};

// @route PUT /api/company/integrations/sheet   { webAppUrl }
// Saves the address only if writing the company's leads to it works.
const connectSheet = async (req, res) => {
  const webAppUrl = String((req.body && req.body.webAppUrl) || '').trim();
  if (!isWebAppUrl(webAppUrl)) {
    return res.status(400).json({ message: 'Paste the Web app URL from Apps Script. It starts with https://script.google.com/ and ends with /exec.' });
  }
  try {
    const integration = await integrationFor(req.leadsCompanyId);
    const previous = { webAppUrl: integration.webAppUrl, connectedAt: integration.connectedAt, connectedBy: integration.connectedBy };
    integration.webAppUrl = webAppUrl;
    integration.connectedAt = new Date();
    integration.connectedBy = req.user._id;
    await integration.save();
    try {
      const { count } = await syncCompany(req.leadsCompanyId);
      log('SHEET_CONNECTED', { companyId: String(req.leadsCompanyId), count });
      return res.json({ ...view(await integrationFor(req.leadsCompanyId)), message: `Connected — ${count} lead${count === 1 ? '' : 's'} written to your sheet` });
    } catch (error) {
      // not working: keep what was there before
      Object.assign(integration, previous);
      await integration.save();
      return res.status(400).json({ message: error.message });
    }
  } catch (error) {
    fail(res, error, 'Server error connecting the Google Sheet');
  }
};

// @route POST /api/company/integrations/sheet/sync   (write the leads now)
const syncSheetNow = async (req, res) => {
  try {
    const integration = await integrationFor(req.leadsCompanyId);
    if (!integration.webAppUrl) return res.status(409).json({ message: 'Connect your Google Sheet first' });
    try {
      const { count } = await syncCompany(req.leadsCompanyId);
      return res.json({ ...view(await integrationFor(req.leadsCompanyId)), message: `${count} lead${count === 1 ? '' : 's'} written to your sheet` });
    } catch (error) {
      return res.status(400).json({ ...view(await integrationFor(req.leadsCompanyId)), message: error.message });
    }
  } catch (error) {
    fail(res, error, 'Server error updating the Google Sheet');
  }
};

// @route POST /api/company/integrations/sheet/secret   (a new secret: the old script stops working)
const newSheetSecret = async (req, res) => {
  try {
    const integration = await integrationFor(req.leadsCompanyId);
    integration.secretEncrypted = encryptToken(generateOAuthState());
    await integration.save();
    log('SHEET_SECRET_RENEWED', { companyId: String(req.leadsCompanyId) });
    res.json(view(integration));
  } catch (error) {
    fail(res, error, 'Server error making a new secret');
  }
};

// @route DELETE /api/company/integrations/sheet   (stop updating the sheet; what is in it stays)
const disconnectSheet = async (req, res) => {
  try {
    const integration = await integrationFor(req.leadsCompanyId);
    integration.webAppUrl = '';
    integration.connectedAt = null;
    integration.lastError = '';
    integration.lastErrorAt = null;
    await integration.save();
    log('SHEET_DISCONNECTED', { companyId: String(req.leadsCompanyId) });
    res.json(view(integration));
  } catch (error) {
    fail(res, error, 'Server error disconnecting the Google Sheet');
  }
};

module.exports = { getSheet, connectSheet, syncSheetNow, newSheetSecret, disconnectSheet };

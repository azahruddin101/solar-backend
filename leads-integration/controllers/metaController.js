const mongoose = require('mongoose');
const User = require('../models/User');
const MetaIntegration = require('../models/MetaIntegration');
const MetaLead = require('../models/MetaLead');
const MetaOAuthState = require('../models/MetaOAuthState');
const MetaLeadAssignment = require('../models/MetaLeadAssignment');
const {
  META_OAUTH_SCOPES,
  META_ALLOWED_ROLES,
  getMetaConfig,
  isMetaAppFromEnv,
  isValidUrl,
  isMetaConfigured,
  isMetaWebhookConfigured,
  safeReturnTo,
} = require('../config/meta');
const { encryptToken, decryptToken, sha256Hex, generateOAuthState } = require('../utils/metaCrypto');
const { OAUTH_CALLBACK_PATH, WEBHOOK_PATH, refreshMetaSettings } = require('../utils/metaSettings');
// verifyAppCredentials is called through the module object so it can be replaced in tests
const metaGraph = require('../utils/metaGraph');
const {
  MetaGraphError,
  buildOAuthDialogUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getMetaUser,
  getGrantedPermissions,
  getUserPages,
  getPageLeadForms,
  subscribePageToLeadgen,
  unsubscribePage,
} = require('../utils/metaGraph');
const { requeueFailedLeads, kickMetaLeadWorker } = require('../workers/metaLeadWorker');
const { logMetaEvent, logMetaError } = require('../utils/metaLogger');
const { narrowRange } = require('../utils/sessionScope');
const { readPriorityFilter, priorityCondition } = require('../utils/leadPriority');
const { integrationQuery, leadCompanyFilter, companyObjectId, runWithLeadCompany } = require('../utils/tenant');
const { assignedScope } = require('../utils/leadScope');
const { convertedStatusIds, pageConvertedLast } = require('../utils/convertedLast');
const { applyLeadSearch } = require('../utils/leadSearch');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_FORMS_PER_PAGE = 50;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;

const getIntegration = (companyId) => MetaIntegration.findOne(integrationQuery(companyId));

// Meta can only deliver webhooks to a public HTTPS address
const isPublicHttps = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(url.hostname) && !url.hostname.endsWith('.localhost');
  } catch (error) {
    return false;
  }
};

const toStringParam = (value) => (typeof value === 'string' ? value.trim() : '');


// Send the browser back to the frontend integration page after the OAuth callback
// (the page that started the login, or the default Integrations page)
const redirectToFrontend = (res, params, returnTo) => {
  const url = new URL(safeReturnTo(returnTo) || getMetaConfig().frontendRedirectUrl);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return res.redirect(url.toString());
};

// Translate Meta/Graph failures into safe API responses.
// 401 is never used here: the frontend treats 401 as an expired CRM session and logs the user out.
const sendMetaError = async (res, error, fallbackMessage, companyId) => {
  if (error instanceof MetaGraphError) {
    logMetaError('META_API_ERROR', { kind: error.kind, code: error.code, fbtraceId: error.fbtraceId });

    switch (error.kind) {
      case 'TOKEN_INVALID':
        if (companyId) {
          await MetaIntegration.updateOne(integrationQuery(companyId), { $set: { needsReconnect: true } }).catch(() => {});
        }
        return res.status(409).json({
          code: 'META_RECONNECT_REQUIRED',
          message: 'The Meta connection has expired or was revoked. Please reconnect Meta.',
        });
      case 'PERMISSION':
        return res.status(403).json({
          code: 'META_PERMISSION_DENIED',
          message: 'Meta denied access. Make sure every requested permission was granted and that you can access this Page and its leads.',
        });
      case 'RATE_LIMIT':
        return res.status(429).json({
          code: 'META_RATE_LIMITED',
          message: 'Meta rate limit reached. Please try again in a few minutes.',
        });
      case 'INVALID_REQUEST':
        return res.status(404).json({
          code: 'META_NOT_AVAILABLE',
          message: 'The requested Facebook Page or lead form is not available on Meta.',
        });
      default:
        return res.status(502).json({
          code: 'META_UNAVAILABLE',
          message: 'Meta is temporarily unavailable. Please try again.',
        });
    }
  }

  logMetaError('META_INTERNAL_ERROR', { reason: error.name });
  return res.status(500).json({ message: fallbackMessage });
};

// Values the owner copies into their Meta app. Never includes the App Secret.
const buildSetupInfo = () => {
  const config = getMetaConfig();
  const apiBaseUrl = config.redirectUri.endsWith(OAUTH_CALLBACK_PATH)
    ? config.redirectUri.slice(0, -OAUTH_CALLBACK_PATH.length)
    : '';

  return {
    // 'company' = entered on the Integrations page, 'env' = fixed in the server environment, null = not set up yet
    source: config.source,
    appId: config.appId,
    redirectUri: config.redirectUri,
    webhookCallbackUrl: apiBaseUrl ? `${apiBaseUrl}${WEBHOOK_PATH}` : '',
    // A verify token that comes from the server environment is not shown
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ? '' : config.webhookVerifyToken,
    webhookRegistered: Boolean(config.webhookRegistered),
  };
};

// Forget the Facebook connection (tokens, Pages, forms). Collected leads and app settings are kept.
const resetConnection = (integration) => {
  integration.connected = false;
  integration.needsReconnect = false;
  integration.metaUserId = '';
  integration.metaUserName = '';
  integration.grantedScopes = [];
  integration.pages = [];
  integration.selectedPageId = null;
  integration.forms = [];
  integration.webhookSubscribed = false;
};

// @desc    Save the Meta app (App ID + App Secret) entered by the admin
// @route   PUT /api/integrations/meta/app-settings
// @access  Private (admin, manager)
const saveMetaAppSettings = async (req, res) => {
  if (isMetaAppFromEnv()) {
    return res.status(409).json({ message: 'The Meta app is set in the server environment and cannot be changed here' });
  }

  const body = req.body || {};
  const appId = toStringParam(body.appId);
  const appSecret = toStringParam(body.appSecret);
  const apiBaseUrl = toStringParam(body.apiBaseUrl).replace(/\/+$/, '');
  const frontendRedirectUrl = safeReturnTo(toStringParam(body.frontendRedirectUrl));

  if (!/^\d{5,25}$/.test(appId)) {
    return res.status(400).json({ message: 'Enter a valid Meta App ID (numbers only)' });
  }
  if (!/^[A-Za-z0-9]{16,128}$/.test(appSecret)) {
    return res.status(400).json({ message: 'Enter a valid Meta App Secret' });
  }
  if (!isValidUrl(apiBaseUrl)) {
    return res.status(400).json({ message: 'Invalid CRM address' });
  }

  try {
    // Ask Meta whether this App ID / App Secret pair is real before storing it
    try {
      await metaGraph.verifyAppCredentials(appId, appSecret);
    } catch (error) {
      if (error instanceof MetaGraphError && !error.retryable) {
        logMetaError('META_APP_SETTINGS_REJECTED', { userId: String(req.user._id), code: error.code });
        return res.status(400).json({
          message: 'Meta did not accept this App ID and App Secret. Copy both again from App settings > Basic.',
        });
      }
      throw error;
    }

    const companyId = req.leadsCompanyId;
    const integration = (await getIntegration(companyId)) || new MetaIntegration({ company: companyId });
    const previous = integration.appSettings || {};

    // Tokens issued for another Meta app are useless with the new one
    if (previous.appId && previous.appId !== appId) {
      resetConnection(integration);
    }

    // Keep the existing verify token so a webhook already set up in Meta keeps working
    let verifyToken = generateOAuthState();
    if (previous.webhookVerifyTokenEncrypted) {
      try {
        verifyToken = decryptToken(previous.webhookVerifyTokenEncrypted);
      } catch (error) {
        // Unreadable with the current key - a new token is issued
      }
    }

    integration.appSettings = {
      appId,
      appSecretEncrypted: encryptToken(appSecret),
      webhookVerifyTokenEncrypted: encryptToken(verifyToken),
      apiBaseUrl,
      frontendRedirectUrl,
      configuredBy: req.user._id,
      configuredAt: new Date(),
    };
    await integration.save();
    await refreshMetaSettings(companyId);

    // Ask Meta to send this app's new leads here, so nobody has to set up the webhook by hand.
    // Saved first: Meta checks the verify token against this CRM while registering.
    const webhookUrl = `${apiBaseUrl}${WEBHOOK_PATH}`;
    let webhookError = '';
    if (!isPublicHttps(webhookUrl)) {
      webhookError = 'Meta can only send leads to a public https:// address, so new leads won’t arrive on this test setup.';
    } else {
      try {
        await metaGraph.subscribeAppWebhook(appId, appSecret, webhookUrl, verifyToken);
      } catch (error) {
        logMetaError('META_APP_WEBHOOK_FAILED', { kind: error.kind, code: error.code });
        webhookError = 'Meta couldn’t register the lead webhook automatically. Add it by hand with the values below.';
      }
    }
    integration.appSettings.webhookRegistered = !webhookError;
    integration.appSettings.webhookError = webhookError;
    await integration.save();
    await refreshMetaSettings(companyId);

    logMetaEvent('META_APP_SETTINGS_SAVED', { userId: String(req.user._id), appId });
    res.json({ message: 'Meta app settings saved', setup: buildSetupInfo() });
  } catch (error) {
    await sendMetaError(res, error, 'Server error saving Meta app settings', req.leadsCompanyId);
  }
};

// @desc    Get Meta integration status
// @route   GET /api/integrations/meta/status
// @access  Private (admin, manager)
const getMetaStatus = async (req, res) => {
  try {
    const integration = await getIntegration(req.leadsCompanyId);
    const connected = Boolean(integration && integration.connected);

    const tenant = leadCompanyFilter(req.leadsCompanyId);
    const [processed, pending, failed] = await Promise.all([
      MetaLead.countDocuments({ ...tenant, processingStatus: 'processed', isDeleted: false }),
      MetaLead.countDocuments({ ...tenant, processingStatus: { $in: ['pending', 'processing'] } }),
      MetaLead.countDocuments({ ...tenant, processingStatus: 'failed' }),
    ]);

    const selectedPage = connected
      ? integration.pages.find((p) => p.pageId === integration.selectedPageId)
      : null;
    const forms = connected ? integration.forms.map((f) => ({ formId: f.formId, formName: f.formName })) : [];

    res.json({
      configured: isMetaConfigured(req.leadsCompanyId),
      setup: buildSetupInfo(),
      webhookConfigured: isMetaWebhookConfigured(req.leadsCompanyId),
      connected,
      needsReconnect: connected && integration.needsReconnect,
      metaUserName: connected ? integration.metaUserName : '',
      selectedPage: selectedPage ? { pageId: selectedPage.pageId, pageName: selectedPage.pageName } : null,
      forms,
      receivingLeads: Boolean(
        connected && selectedPage && forms.length > 0 && integration.webhookSubscribed && !integration.needsReconnect
      ),
      connectedAt: connected ? integration.connectedAt : null,
      lastLeadReceivedAt: connected ? integration.lastLeadReceivedAt || null : null,
      leadCounts: { processed, pending, failed },
    });
  } catch (error) {
    await sendMetaError(res, error, 'Server error retrieving Meta integration status');
  }
};

// @desc    Start Meta OAuth - returns the Facebook Login URL to redirect the browser to
// @route   GET /api/integrations/meta/connect
// @access  Private (admin, manager)
const startMetaConnect = async (req, res) => {
  if (!isMetaConfigured()) {
    return res.status(503).json({ message: 'Enter your Meta App ID and App Secret first' });
  }

  try {
    const state = generateOAuthState();
    await MetaOAuthState.create({
      stateHash: sha256Hex(state),
      user: req.user._id,
      company: req.leadsCompanyId,
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      returnTo: safeReturnTo(toStringParam(req.query.returnTo)),
    });

    logMetaEvent('META_OAUTH_STARTED', { userId: String(req.user._id) });
    res.json({ url: buildOAuthDialogUrl(state) });
  } catch (error) {
    await sendMetaError(res, error, 'Server error starting Meta connection');
  }
};

// @desc    Meta OAuth callback - exchanges the code, stores encrypted Page tokens, redirects to the frontend
// @route   GET /api/integrations/meta/callback
// @access  Public (browser redirect from Meta, validated with the single-use OAuth state)
const handleMetaCallback = async (req, res) => {
  const failPlain = (message) => res.status(400).send(message);

  try {
    const state = toStringParam(req.query.state);
    const code = toStringParam(req.query.code);

    const stateRecord = state
      ? await MetaOAuthState.findOneAndDelete({ stateHash: sha256Hex(state), expiresAt: { $gt: new Date() } })
      : null;

    if (req.query.error) {
      if (!stateRecord) return failPlain('Meta login was cancelled.');
      await refreshMetaSettings(stateRecord.company);
      return runWithLeadCompany(stateRecord.company, () => {
        logMetaError('META_OAUTH_FAILED', { reason: 'access_denied' });
        return redirectToFrontend(res, { meta: 'error', reason: 'access_denied' }, stateRecord.returnTo);
      });
    }
    if (!stateRecord) {
      return failPlain('Invalid or expired Meta login session. Start again from Integrations.');
    }

    const companyId = String(stateRecord.company);
    await refreshMetaSettings(companyId);

    return runWithLeadCompany(companyId, async () => {
      const fail = (reason, details = {}) => {
        logMetaError('META_OAUTH_FAILED', { reason, ...details });
        return redirectToFrontend(res, { meta: 'error', reason }, stateRecord.returnTo);
      };

      if (!isMetaConfigured(companyId)) {
        return fail('not_configured');
      }
      if (!code) {
        return fail('missing_code');
      }

      // The user who started the connect must still be an active owner of this same company
      const user = await User.findOne({ ...integrationQuery(companyId), _id: stateRecord.user });
      if (!user || user.active === false || !META_ALLOWED_ROLES.includes(user.role)) {
        return fail('not_authorized');
      }
      const userId = String(user._id);

      const shortLivedToken = await exchangeCodeForToken(code);
      const userToken = await exchangeForLongLivedToken(shortLivedToken);

      const grantedScopes = await getGrantedPermissions(userToken);
      const missingScopes = META_OAUTH_SCOPES.filter((scope) => !grantedScopes.includes(scope));
      if (missingScopes.length > 0) {
        return fail('missing_permissions', { userId, missingScopes });
      }

      const metaUser = await getMetaUser(userToken);
      const pages = (await getUserPages(userToken)).filter((page) => page.id && page.access_token);
      if (pages.length === 0) {
        return fail('no_pages', { userId });
      }

      const integration = (await getIntegration(companyId)) || new MetaIntegration({ company: companyId });
      const previousPageId = integration.selectedPageId;

      integration.connected = true;
      integration.needsReconnect = false;
      integration.metaUserId = String(metaUser.id);
      integration.metaUserName = metaUser.name || '';
      integration.grantedScopes = grantedScopes;
      integration.connectedBy = user._id;
      integration.connectedAt = new Date();
      integration.pages = pages.map((page) => ({
        pageId: String(page.id),
        pageName: page.name || '',
        accessTokenEncrypted: encryptToken(page.access_token),
        tokenExpiresAt: null,
      }));

      const previousPage = pages.find((page) => String(page.id) === previousPageId);
      if (previousPage) {
        try {
          await subscribePageToLeadgen(previousPageId, previousPage.access_token);
          integration.webhookSubscribed = true;
        } catch (error) {
          integration.webhookSubscribed = false;
        }
      } else {
        integration.selectedPageId = null;
        integration.forms = [];
        integration.webhookSubscribed = false;
      }

      await integration.save();

      if (previousPage) {
        await requeueFailedLeads(previousPageId, companyId);
        kickMetaLeadWorker();
      }

      logMetaEvent('META_OAUTH_SUCCESS', { userId, pageCount: pages.length });
      return redirectToFrontend(res, { meta: 'connected' }, stateRecord.returnTo);
    });
  } catch (error) {
    if (error instanceof MetaGraphError) {
      logMetaError('META_OAUTH_FAILED', { kind: error.kind, code: error.code });
      return res.status(502).send('Meta is temporarily unavailable. Try again from Integrations.');
    }
    logMetaError('META_OAUTH_FAILED', { error: error.name });
    return res.status(500).send('Server error completing Meta login.');
  }
};

// @desc    List the Facebook Pages available through the Meta connection
// @route   GET /api/integrations/meta/pages
// @access  Private (admin, manager)
const getMetaPages = async (req, res) => {
  try {
    const integration = await getIntegration(req.leadsCompanyId);
    if (!integration || !integration.connected) {
      return res.status(409).json({ message: 'Meta is not connected' });
    }

    res.json(
      integration.pages.map((page) => ({
        pageId: page.pageId,
        pageName: page.pageName,
        selected: page.pageId === integration.selectedPageId,
      }))
    );
  } catch (error) {
    await sendMetaError(res, error, 'Server error retrieving Facebook Pages');
  }
};

// Resolve a Page ID from the request against the stored integration - never trust the ID on its own
const findConnectedPage = (integration, pageId) => {
  if (!integration || !integration.connected) return null;
  return integration.pages.find((page) => page.pageId === pageId) || null;
};

const fetchActiveForms = async (page) => {
  const forms = await getPageLeadForms(page.pageId, decryptToken(page.accessTokenEncrypted));
  return forms.filter((form) => form.id && !['ARCHIVED', 'DELETED'].includes(form.status));
};

// @desc    List the lead forms of a connected Facebook Page
// @route   GET /api/integrations/meta/pages/:pageId/forms
// @access  Private (admin, manager)
const getMetaPageForms = async (req, res) => {
  try {
    const integration = await getIntegration(req.leadsCompanyId);
    const page = findConnectedPage(integration, req.params.pageId);
    if (!page) {
      return res.status(404).json({ message: 'Facebook Page not found in the Meta connection' });
    }

    const forms = await fetchActiveForms(page);
    const selectedFormIds =
      integration.selectedPageId === page.pageId ? integration.forms.map((f) => f.formId) : [];

    res.json(
      forms.map((form) => ({
        formId: String(form.id),
        formName: form.name || '',
        status: form.status || '',
        selected: selectedFormIds.includes(String(form.id)),
      }))
    );
  } catch (error) {
    await sendMetaError(res, error, 'Server error retrieving lead forms');
  }
};

// @desc    Connect the selected lead forms of a Page (subscribes the Page to leadgen webhooks)
// @route   POST /api/integrations/meta/pages/:pageId/forms
// @access  Private (admin, manager)
const connectMetaForms = async (req, res) => {
  const formIds = Array.isArray(req.body && req.body.formIds)
    ? [...new Set(req.body.formIds.map((id) => String(id).trim()))]
    : [];

  if (formIds.length === 0 || formIds.length > MAX_FORMS_PER_PAGE || !formIds.every((id) => /^\d+$/.test(id))) {
    return res.status(400).json({ message: 'Select at least one lead form' });
  }

  try {
    const integration = await getIntegration(req.leadsCompanyId);
    const page = findConnectedPage(integration, req.params.pageId);
    if (!page) {
      return res.status(404).json({ message: 'Facebook Page not found in the Meta connection' });
    }

    // Leads are routed to a company by their Page, so a Page can feed only one company
    const takenByOther = await MetaIntegration.exists({
      company: { $ne: companyObjectId(req.leadsCompanyId) },
      connected: true,
      selectedPageId: page.pageId,
    });
    if (takenByOther) {
      return res.status(409).json({ message: 'This Facebook Page is already connected to another workspace. Disconnect it there first.' });
    }

    // Every selected form must belong to this Page according to Meta
    const pageForms = await fetchActiveForms(page);
    const selectedForms = formIds.map((id) => pageForms.find((form) => String(form.id) === id));
    if (selectedForms.some((form) => !form)) {
      return res.status(400).json({ message: 'One or more selected lead forms do not belong to this Facebook Page' });
    }

    await subscribePageToLeadgen(page.pageId, decryptToken(page.accessTokenEncrypted));

    // Stop receiving leads from a previously selected Page (best effort)
    const previousPage = integration.pages.find(
      (p) => p.pageId === integration.selectedPageId && p.pageId !== page.pageId
    );
    if (previousPage) {
      await unsubscribePage(previousPage.pageId, decryptToken(previousPage.accessTokenEncrypted)).catch(() => {});
    }

    integration.selectedPageId = page.pageId;
    integration.forms = selectedForms.map((form) => ({ formId: String(form.id), formName: form.name || '' }));
    integration.webhookSubscribed = true;
    await integration.save();

    await requeueFailedLeads(page.pageId, req.leadsCompanyId);
    kickMetaLeadWorker();

    const userId = String(req.user._id);
    logMetaEvent('META_PAGE_CONNECTED', { userId, pageId: page.pageId });
    logMetaEvent('META_FORM_CONNECTED', { userId, pageId: page.pageId, formIds });

    res.json({
      message: 'Meta lead forms connected successfully',
      selectedPage: { pageId: page.pageId, pageName: page.pageName },
      forms: integration.forms.map((f) => ({ formId: f.formId, formName: f.formName })),
    });
  } catch (error) {
    if (error && error.code === 11000) {
      // another workspace connected the same Page at the same moment (unique index on selectedPageId)
      return res.status(409).json({ message: 'This Facebook Page is already connected to another workspace. Disconnect it there first.' });
    }
    await sendMetaError(res, error, 'Server error connecting lead forms');
  }
};

// @desc    Disconnect Meta - removes stored tokens, collected leads are kept
// @route   DELETE /api/integrations/meta
// @access  Private (admin, manager)
const disconnectMeta = async (req, res) => {
  try {
    const integration = await getIntegration(req.leadsCompanyId);
    if (!integration || !integration.connected) {
      return res.json({ message: 'Meta is not connected' });
    }

    // Stop webhook deliveries for the selected Page (best effort - the token may already be invalid)
    const selectedPage = integration.pages.find((p) => p.pageId === integration.selectedPageId);
    if (selectedPage) {
      try {
        await unsubscribePage(selectedPage.pageId, decryptToken(selectedPage.accessTokenEncrypted));
      } catch (error) {
        logMetaError('META_UNSUBSCRIBE_FAILED', { pageId: selectedPage.pageId });
      }
    }

    resetConnection(integration);
    await integration.save();

    logMetaEvent('META_DISCONNECTED', { userId: String(req.user._id) });
    res.json({ message: 'Meta disconnected successfully' });
  } catch (error) {
    await sendMetaError(res, error, 'Server error disconnecting Meta');
  }
};

// @desc    Get Meta leads (server-side pagination, search and filters)
// @route   GET /api/integrations/meta/leads?page=&limit=&search=&formId=&pageId=&from=&to=&assignedTo=&statusId=&priority=
// @access  Private (admin, manager)
const getMetaLeads = async (req, res) => {
  const page = Math.max(parseInt(toStringParam(req.query.page), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(toStringParam(req.query.limit), 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const search = toStringParam(req.query.search).slice(0, MAX_SEARCH_LENGTH).toLowerCase();
  const formId = toStringParam(req.query.formId);
  const pageId = toStringParam(req.query.pageId);
  const from = toStringParam(req.query.from);
  const to = toStringParam(req.query.to);
  // 'unassigned', or a telecaller's user ID
  const assignedTo = toStringParam(req.query.assignedTo);
  // 'none' (assigned but not started), or a lead status ID
  const statusId = toStringParam(req.query.statusId);
  // 'true' (priority only) or 'false' (not priority)
  const { priority, invalid: invalidPriority } = readPriorityFilter(req.query.priority);

  const tenant = leadCompanyFilter(req.leadsCompanyId);
  const filter = { ...tenant, processingStatus: 'processed', isDeleted: false };

  if ((assignedTo && assignedTo !== 'unassigned' && !mongoose.isValidObjectId(assignedTo)) ||
      (statusId && statusId !== 'none' && !mongoose.isValidObjectId(statusId)) ||
      invalidPriority) {
    return res.status(400).json({ message: 'Invalid filter' });
  }
  if (assignedTo === 'unassigned') filter.assignedTo = { $exists: false };
  else if (assignedTo) filter.assignedTo = assignedTo;

  if (formId) filter.formId = formId;
  if (pageId) filter.pageId = pageId;
  if (priority !== null) filter.isPriority = priorityCondition(priority);

  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
    return res.status(400).json({ message: 'Invalid date filter' });
  }
  // Page date filter is applied within the selected session's range
  const leadCreatedRange = narrowRange(req, fromDate, toDate);
  if (leadCreatedRange) filter.leadCreatedAt = leadCreatedRange;
  // staff who may only see their own leads: whatever the filter asked for
  Object.assign(filter, assignedScope(req));

  try {
    // one box: answers, form / Page name, assignee, status or a date
    await applyLeadSearch(filter, { companyId: req.leadsCompanyId, search, kind: 'meta' });
    // A counsellor's status wins. Before anyone is assigned, the admin's status on the lead is used.
    if (statusId) {
      if (statusId === 'none') {
        const notStarted = await MetaLeadAssignment.distinct('lead', { ...tenant, isActive: true, currentStatus: null });
        const coveredByAdmin = await MetaLead.distinct('_id', {
          ...tenant,
          _id: { $in: notStarted },
          adminStatus: { $ne: null },
        });
        const covered = new Set(coveredByAdmin.map(String));
        filter._id = { $in: notStarted.filter((id) => !covered.has(String(id))) };
      } else {
        const owned = await MetaLeadAssignment.distinct('lead', { ...tenant, isActive: true, currentStatus: statusId });
        const ownerHasStatus = await MetaLeadAssignment.distinct('lead', { ...tenant, isActive: true, currentStatus: { $ne: null } });
        const adminOnly = await MetaLead.distinct('_id', {
          ...tenant,
          adminStatus: statusId,
          _id: { $nin: ownerHasStatus },
        });
        filter._id = { $in: [...owned, ...adminOnly] };
      }
    }

    // Converted ("registered") leads go last. A lead's status is its owner's status, or the admin's before anyone set one.
    const convertedIds = await convertedStatusIds(req.leadsCompanyId);
    let converted = null;
    if (convertedIds.length) {
      const [byOwner, ownerHasStatus] = await Promise.all([
        MetaLeadAssignment.distinct('lead', { ...tenant, isActive: true, currentStatus: { $in: convertedIds } }),
        MetaLeadAssignment.distinct('lead', { ...tenant, isActive: true, currentStatus: { $ne: null } }),
      ]);
      const byAdmin = await MetaLead.distinct('_id', { ...tenant, adminStatus: { $in: convertedIds }, _id: { $nin: ownerHasStatus } });
      converted = { _id: { $in: [...byOwner, ...byAdmin] } };
    }
    const [leads, total] = await Promise.all([
      pageConvertedLast(MetaLead, filter, converted, (cond) => MetaLead.find(cond)
        .select('-rawData -searchText -processingStatus -attempts -nextAttemptAt -lockedAt -lastError -isDeleted')
        .populate('assignedTo', 'name email')
        .populate('adminStatus', 'name color isConversion')
        .sort({ leadCreatedAt: -1, _id: -1 }), { skip: (page - 1) * limit, limit }),
      MetaLead.countDocuments(filter),
    ]);

    // Attach the current owner's status to each lead on this page
    const assignments = await MetaLeadAssignment.find({ ...tenant, lead: { $in: leads.map((lead) => lead._id) }, isActive: true })
      .select('lead currentStatus lastActivityAt')
      .populate('currentStatus', 'name color')
      .lean();
    const assignmentByLead = new Map(assignments.map((assignment) => [String(assignment.lead), assignment]));
    leads.forEach((lead) => {
      const assignment = assignmentByLead.get(String(lead._id));
      lead.currentStatus = (assignment && assignment.currentStatus) || lead.adminStatus || null;
      lead.lastActivityAt = (assignment && assignment.lastActivityAt) || lead.adminStatusUpdatedAt || null;
      lead.isPriority = Boolean(lead.isPriority);
    });

    res.json({
      leads,
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (error) {
    await sendMetaError(res, error, 'Server error retrieving Meta leads');
  }
};

// @desc    Get the Pages and forms that have leads (for the lead list filters)
// @route   GET /api/integrations/meta/leads/filters
// @access  Private (admin, manager)
const getMetaLeadFilters = async (req, res) => {
  try {
    const groups = await MetaLead.aggregate([
      { $match: { ...leadCompanyFilter(req.leadsCompanyId), processingStatus: 'processed', isDeleted: false } },
      {
        $group: {
          _id: { pageId: '$pageId', formId: '$formId' },
          pageName: { $last: '$pageName' },
          formName: { $last: '$formName' },
        },
      },
    ]);

    const pages = new Map();
    const forms = groups.map((group) => {
      pages.set(group._id.pageId, group.pageName || group._id.pageId);
      return {
        formId: group._id.formId,
        formName: group.formName || group._id.formId,
        pageId: group._id.pageId,
      };
    });

    res.json({
      pages: [...pages].map(([pageId, pageName]) => ({ pageId, pageName })),
      forms,
    });
  } catch (error) {
    await sendMetaError(res, error, 'Server error retrieving Meta lead filters');
  }
};

// @desc    Put leads that could not be retrieved from Meta back in the queue
// @route   POST /api/integrations/meta/leads/retry-failed
// @access  Private (admin, manager)
const retryFailedMetaLeads = async (req, res) => {
  try {
    const requeued = await requeueFailedLeads(undefined, req.leadsCompanyId);
    kickMetaLeadWorker();
    res.json({ message: `${requeued} lead(s) queued for retry`, requeued });
  } catch (error) {
    await sendMetaError(res, error, 'Server error retrying Meta leads');
  }
};

module.exports = {
  saveMetaAppSettings,
  getMetaStatus,
  startMetaConnect,
  handleMetaCallback,
  getMetaPages,
  getMetaPageForms,
  connectMetaForms,
  disconnectMeta,
  getMetaLeads,
  getMetaLeadFilters,
  retryFailedMetaLeads,
};

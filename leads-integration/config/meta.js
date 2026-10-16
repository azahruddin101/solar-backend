// Meta (Facebook) Lead Ads integration configuration.
//
// Each company connects its own Meta app: the owner enters its App ID + App Secret on the Integrations page
// (stored encrypted per company). META_APP_ID / META_APP_SECRET in the server environment, when set, take precedence.

const DEFAULT_GRAPH_API_VERSION = 'v26.0';

// Permissions requested during Facebook Login (the OAuth `scope` parameter).
//
// This is exactly the permission set of the Meta app use case
// "Capture & manage ad leads with Marketing API" (verified against Meta's docs, Graph API v26.0).
// Meta rejects the login with "Invalid Scopes" for any permission that has not been added to
// the app under that use case, so the app must have the use case and every permission below.
// With Standard Access they can be granted by people who have a role on the Meta app;
// serving anyone else needs Advanced Access (App Review + Business Verification).
const META_OAUTH_SCOPES = [
  // Required by the use case
  'pages_show_list', // list the Pages the user manages
  'pages_read_engagement', // read Page data (dependency of the permissions below)
  'pages_manage_ads', // dependency of leads_retrieval
  'leads_retrieval', // read lead form answers
  'ads_management', // dependency of leads_retrieval; campaign / ad set / ad fields on a lead
  'ads_read', // dependency of leads_retrieval
  'business_management', // dependency of leads_retrieval; Pages owned by a business portfolio
  // Optional in the use case - has to be added in the Meta app with the "Add" button
  'pages_manage_metadata', // subscribe the Page to leadgen webhooks
];

// CRM roles allowed to manage the Meta integration and view Meta leads
const META_ALLOWED_ROLES = ['company'];
const { getLeadCompanyId } = require('../utils/tenant');

// Per-company Meta app settings (decrypted), refreshed before each API call.
const settingsByCompany = new Map();
let storedSettings = null;

const setStoredMetaSettings = (settings, companyId) => {
  if (companyId) settingsByCompany.set(String(companyId), settings || null);
  else storedSettings = settings || null;
};

const normalizeVersion = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (/^v\d+\.\d+$/.test(trimmed)) return trimmed;
  if (/^\d+\.\d+$/.test(trimmed)) return `v${trimmed}`;
  return null;
};

// True when the Meta app is supplied through the server environment instead of the CRM
const isMetaAppFromEnv = () => Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);

// CRM web addresses allowed to receive the browser back after Facebook Login (the CORS origins)
const crmOrigins = () =>
  (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const DEFAULT_RETURN_PATH = '/dashboard/leads/integrations';

const getMetaConfig = (companyId) => {
  const cid = companyId || getLeadCompanyId();
  const own = (cid && settingsByCompany.get(String(cid))) || storedSettings || {};
  const fromEnv = isMetaAppFromEnv();
  const ownApp = !fromEnv && Boolean(own.appId && own.appSecret);
  const app = ownApp ? own : {};
  const appSecret = fromEnv ? process.env.META_APP_SECRET : app.appSecret || '';

  return {
    // 'env' | 'company' | null (not set up yet)
    source: fromEnv ? 'env' : ownApp ? 'company' : null,
    appId: fromEnv ? process.env.META_APP_ID : app.appId || '',
    appSecret,
    redirectUri: process.env.META_REDIRECT_URI || app.redirectUri || '',
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || app.webhookVerifyToken || '',
    // the company's own app: whether the CRM registered its lead webhook with Meta
    webhookRegistered: ownApp ? Boolean(own.webhookRegistered) : false,
    webhookError: ownApp ? own.webhookError || '' : '',
    // The webhook payload is signed with the app secret; allow an explicit override
    webhookAppSecret: process.env.META_WEBHOOK_APP_SECRET || appSecret,
    graphApiVersion: normalizeVersion(process.env.META_GRAPH_API_VERSION) || DEFAULT_GRAPH_API_VERSION,
    // Optional dedicated key for encrypting stored secrets (falls back to a key derived from JWT_SECRET)
    tokenEncryptionKey: process.env.META_TOKEN_ENCRYPTION_KEY || '',
    // Fallback page the browser is sent back to after the OAuth callback (normally the page that started it)
    frontendRedirectUrl:
      process.env.META_FRONTEND_REDIRECT_URL || own.frontendRedirectUrl || `${crmOrigins()[0]}${DEFAULT_RETURN_PATH}`,
  };
};

// A CRM page to return to after Facebook Login: only on an allowed CRM origin, without query or fragment
const safeReturnTo = (value) => {
  try {
    const url = new URL(String(value || ''));
    if (!crmOrigins().includes(url.origin)) return '';
    return `${url.origin}${url.pathname}`;
  } catch (error) {
    return '';
  }
};

const isValidUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch (error) {
    return false;
  }
};

// Everything needed to run the OAuth flow and call the Graph API
const isMetaConfigured = (companyId) => {
  const config = getMetaConfig(companyId);
  return Boolean(
    config.appId &&
      config.appSecret &&
      (config.tokenEncryptionKey || process.env.JWT_SECRET) &&
      isValidUrl(config.redirectUri)
  );
};

// Everything needed to verify and accept webhooks
const isMetaWebhookConfigured = (companyId) => {
  const config = getMetaConfig(companyId);
  return Boolean(config.webhookVerifyToken && config.webhookAppSecret);
};

module.exports = {
  DEFAULT_GRAPH_API_VERSION,
  META_OAUTH_SCOPES,
  META_ALLOWED_ROLES,
  setStoredMetaSettings,
  safeReturnTo,
  isMetaAppFromEnv,
  getMetaConfig,
  isValidUrl,
  isMetaConfigured,
  isMetaWebhookConfigured,
};

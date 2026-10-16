const MetaIntegration = require('../models/MetaIntegration');
const { setStoredMetaSettings } = require('../config/meta');
const { decryptToken } = require('./metaCrypto');
const { logMetaError } = require('./metaLogger');
const { integrationQuery, runWithLeadCompany } = require('./tenant');

const OAUTH_CALLBACK_PATH = '/company/integrations/meta/callback';
const WEBHOOK_PATH = '/webhooks/meta';

const refreshMetaSettings = async (companyId) => {
  if (!companyId) {
    setStoredMetaSettings(null);
    return;
  }

  const integration = await MetaIntegration.findOne(integrationQuery(companyId)).select('appSettings').lean();
  const saved = integration && integration.appSettings;

  if (!saved || !saved.appId || !saved.appSecretEncrypted) {
    setStoredMetaSettings(null, companyId);
    return;
  }

  try {
    setStoredMetaSettings(
      {
        appId: saved.appId,
        appSecret: decryptToken(saved.appSecretEncrypted),
        webhookVerifyToken: saved.webhookVerifyTokenEncrypted ? decryptToken(saved.webhookVerifyTokenEncrypted) : '',
        redirectUri: saved.apiBaseUrl ? `${saved.apiBaseUrl}${OAUTH_CALLBACK_PATH}` : '',
        frontendRedirectUrl: saved.frontendRedirectUrl || '',
        webhookRegistered: Boolean(saved.webhookRegistered),
        webhookError: saved.webhookError || '',
      },
      companyId
    );
  } catch (error) {
    setStoredMetaSettings(null, companyId);
    logMetaError('META_SETTINGS_UNREADABLE', { reason: 'decrypt_failed', companyId: String(companyId) });
  }
};

const loadMetaSettings = async (req, res, next) => {
  try {
    const companyId = req.leadsCompanyId || null;
    await refreshMetaSettings(companyId);
    if (companyId) {
      return runWithLeadCompany(companyId, () => next());
    }
    return next();
  } catch (error) {
    logMetaError('META_SETTINGS_LOAD_FAILED', { reason: error.name });
    res.status(500).json({ message: 'Server error loading Meta settings' });
  }
};

module.exports = {
  OAUTH_CALLBACK_PATH,
  WEBHOOK_PATH,
  refreshMetaSettings,
  loadMetaSettings,
};

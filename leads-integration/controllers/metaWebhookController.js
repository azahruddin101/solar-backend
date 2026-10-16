const MetaIntegration = require('../models/MetaIntegration');
const MetaLead = require('../models/MetaLead');
const { getMetaConfig } = require('../config/meta');
const { safeEqual, verifyWebhookSignature, decryptToken } = require('../utils/metaCrypto');
const { kickMetaLeadWorker } = require('../workers/metaLeadWorker');
const { logMetaEvent, logMetaError } = require('../utils/metaLogger');
const { refreshMetaSettings } = require('../utils/metaSettings');
const isMetaId = (value) => /^\d+$/.test(value);

const tokenMatchesAnyIntegration = async (token) => {
  if (typeof token !== 'string' || !token) return false;
  const rows = await MetaIntegration.find({ 'appSettings.webhookVerifyTokenEncrypted': { $exists: true, $ne: '' } })
    .select('appSettings.webhookVerifyTokenEncrypted')
    .lean();
  for (const row of rows) {
    try {
      const expected = decryptToken(row.appSettings.webhookVerifyTokenEncrypted);
      if (safeEqual(token, expected)) return true;
    } catch {
      // skip
    }
  }
  const envToken = String(process.env.META_WEBHOOK_VERIFY_TOKEN || '');
  return envToken && safeEqual(token, envToken);
};

// @desc    Meta webhook verification handshake
// @route   GET /api/webhooks/meta
const verifyMetaWebhook = async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (
    mode === 'subscribe' &&
    typeof token === 'string' &&
    typeof challenge === 'string' &&
    (await tokenMatchesAnyIntegration(token))
  ) {
    return res.status(200).type('text/plain').send(challenge);
  }

  logMetaError('META_WEBHOOK_REJECTED', { reason: 'verification_failed' });
  return res.status(403).json({ message: 'Webhook verification failed' });
};

const extractLeadEvents = (payload) => {
  const events = [];

  payload.entry.forEach((entry) => {
    const changes = entry && Array.isArray(entry.changes) ? entry.changes : [];
    changes.forEach((change) => {
      if (!change || change.field !== 'leadgen' || !change.value) return;

      const value = change.value;
      const event = {
        leadId: String(value.leadgen_id || ''),
        pageId: String(value.page_id || ''),
        formId: String(value.form_id || ''),
        adId: value.ad_id ? String(value.ad_id) : undefined,
        createdTime: Number(value.created_time) || null,
      };

      if (isMetaId(event.leadId) && isMetaId(event.pageId) && isMetaId(event.formId)) {
        events.push(event);
      }
    });
  });

  return events;
};

// The Page and form of this event, when the integration that owns the Page has that form connected
const findIntegrationForEvent = (integration, event) => {
  if (!integration || !integration.connected) return null;
  if (integration.selectedPageId !== event.pageId) return null;
  const page = integration.pages.find((p) => p.pageId === event.pageId);
  const form = page ? integration.forms.find((f) => f.formId === event.formId) : null;
  if (!page || !form) return null;
  return { page, form, companyId: integration.company };
};

// @desc    Receive Meta leadgen webhooks and queue each lead for retrieval
// @route   POST /api/webhooks/meta
const receiveMetaWebhook = async (req, res) => {
  const signature = req.get('X-Hub-Signature-256');

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (error) {
    payload = null;
  }

  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entry)) {
    logMetaError('META_WEBHOOK_REJECTED', { reason: 'invalid_payload' });
    return res.status(400).json({ message: 'Invalid webhook payload' });
  }

  if (payload.object !== 'page') {
    return res.status(200).send('EVENT_RECEIVED');
  }

  const events = extractLeadEvents(payload);
  logMetaEvent('META_WEBHOOK_RECEIVED', { leadEvents: events.length });

  if (events.length === 0) {
    return res.status(200).send('EVENT_RECEIVED');
  }

  // Each lead is routed by its Page to the one company that connected that Page, and only that company's
  // app secret may vouch for it: a payload signed with Company A's secret can never place leads in Company B.
  const signedByCompany = new Map();
  const isSignedBy = async (companyId) => {
    if (!signedByCompany.has(companyId)) {
      await refreshMetaSettings(companyId);
      const secret = getMetaConfig(companyId).webhookAppSecret;
      signedByCompany.set(companyId, Boolean(secret && verifyWebhookSignature(req.body, signature, secret)));
    }
    return signedByCompany.get(companyId);
  };

  try {
    let queued = 0;
    let owned = 0;
    let verified = 0;

    for (const event of events) {
      const owners = await MetaIntegration.find({ connected: true, selectedPageId: event.pageId });
      if (owners.length !== 1) {
        logMetaEvent('META_WEBHOOK_IGNORED', {
          reason: owners.length ? 'page_connected_to_several_companies' : 'page_or_form_not_connected',
          pageId: event.pageId,
          formId: event.formId,
        });
        continue;
      }
      owned += 1;
      const integration = owners[0];
      if (!(await isSignedBy(String(integration.company)))) {
        logMetaError('META_WEBHOOK_REJECTED', { reason: 'invalid_signature', pageId: event.pageId });
        continue;
      }
      verified += 1;

      const match = findIntegrationForEvent(integration, event);
      if (!match) {
        logMetaEvent('META_WEBHOOK_IGNORED', {
          reason: 'page_or_form_not_connected',
          pageId: event.pageId,
          formId: event.formId,
        });
        continue;
      }

      const { page, form, companyId } = match;
      let inserted = false;
      try {
        const newLead = {
          company: companyId,
          source: 'META',
          externalLeadId: event.leadId,
          pageId: page.pageId,
          pageName: page.pageName,
          formId: form.formId,
          formName: form.formName,
          leadCreatedAt: event.createdTime ? new Date(event.createdTime * 1000) : new Date(),
          processingStatus: 'pending',
          attempts: 0,
          nextAttemptAt: new Date(),
          isDeleted: false,
        };
        if (event.adId) newLead.adId = event.adId;

        const result = await MetaLead.updateOne(
          { company: companyId, source: 'META', externalLeadId: event.leadId },
          { $setOnInsert: newLead },
          { upsert: true }
        );
        inserted = result.upsertedCount === 1;
      } catch (error) {
        if (error.code !== 11000) throw error;
      }

      if (inserted) {
        queued += 1;
        logMetaEvent('META_LEAD_QUEUED', { leadId: event.leadId, pageId: event.pageId, formId: event.formId });
      } else {
        logMetaEvent('META_LEAD_DUPLICATE', { leadId: event.leadId });
      }
    }

    if (queued > 0) kickMetaLeadWorker();

    // Leads for connected Pages arrived, but none was signed by its owner's app secret
    if (owned > 0 && verified === 0) {
      return res.status(401).json({ message: 'Invalid webhook signature' });
    }
    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    logMetaError('META_WEBHOOK_QUEUE_FAILED', { reason: error.name });
    return res.status(500).json({ message: 'Could not queue webhook event' });
  }
};

module.exports = {
  verifyMetaWebhook,
  receiveMetaWebhook,
};

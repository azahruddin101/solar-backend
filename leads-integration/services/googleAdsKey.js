const crypto = require('crypto');
const GoogleAdsIntegration = require('../models/GoogleAdsIntegration');
const { encryptToken, decryptToken } = require('../utils/metaCrypto');
const { integrationQuery } = require('../utils/tenant');

const resolveWebhookKey = async (companyId) => {
  if (companyId) {
    const stored = await GoogleAdsIntegration.findOne(integrationQuery(companyId)).lean();
    if (stored && stored.webhookKeyEncrypted) {
      return {
        key: decryptToken(stored.webhookKeyEncrypted),
        source: 'crm',
        createdAt: stored.keyCreatedAt || null,
        companyId: stored.company,
      };
    }
  }

  const envKey = String(process.env.GOOGLE_ADS_WEBHOOK_KEY || '').trim();
  if (envKey) return { key: envKey, source: 'env', createdAt: null, companyId: null };
  return { key: '', source: 'none', createdAt: null, companyId: null };
};

/** Match incoming google_key against any company's stored key (public webhook). */
const resolveWebhookKeyFromPayload = async (receivedKey) => {
  if (typeof receivedKey !== 'string' || !receivedKey.trim()) {
    return { key: '', companyId: null, source: 'none' };
  }

  const docs = await GoogleAdsIntegration.find({ webhookKeyEncrypted: { $ne: '' } }).lean();
  for (const doc of docs) {
    try {
      const key = decryptToken(doc.webhookKeyEncrypted);
      const a = Buffer.from(receivedKey);
      const b = Buffer.from(key);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { key, companyId: doc.company, source: 'crm', createdAt: doc.keyCreatedAt || null };
      }
    } catch {
      // skip unreadable row
    }
  }

  const env = await resolveWebhookKey();
  if (env.key) {
    const a = Buffer.from(receivedKey);
    const b = Buffer.from(env.key);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { ...env, companyId: env.companyId };
    }
  }

  return { key: '', companyId: null, source: 'none' };
};

const generateWebhookKey = async (companyId, userId) => {
  const key = crypto.randomBytes(24).toString('hex');
  await GoogleAdsIntegration.findOneAndUpdate(
    integrationQuery(companyId),
    { $set: { company: companyId, webhookKeyEncrypted: encryptToken(key), keyCreatedAt: new Date(), keyCreatedBy: userId } },
    { upsert: true, setDefaultsOnInsert: true }
  );
  return key;
};

const removeWebhookKey = async (companyId) => {
  await GoogleAdsIntegration.updateOne(integrationQuery(companyId), {
    $set: { webhookKeyEncrypted: '' },
    $unset: { keyCreatedAt: 1, keyCreatedBy: 1 },
  });
};

module.exports = { resolveWebhookKey, resolveWebhookKeyFromPayload, generateWebhookKey, removeWebhookKey };

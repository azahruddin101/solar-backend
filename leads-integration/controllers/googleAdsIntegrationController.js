const GoogleLead = require('../models/GoogleLead');
const { resolveWebhookKey, generateWebhookKey, removeWebhookKey } = require('../services/googleAdsKey');
const { parseGoogleAdsLeadFile } = require('../utils/googleAdsImport');

// Integrations > Google Ads: the webhook key, what has arrived so far, and importing
// leads that came in before the webhook was set up.

const MAX_FORMS_LISTED = 50;

const log = (event, details = {}) => console.log(`[GOOGLE_ADS] ${event} ${JSON.stringify(details)}`);
const serverError = (res, error, message) => {
  console.error(`[GOOGLE_ADS] ${message}:`, error.message);
  res.status(500).json({ message });
};

const loadStatus = async (companyId) => {
  const tenant = { company: companyId };
  const [keyInfo, totals, forms, lastLead, lastTest] = await Promise.all([
    resolveWebhookKey(companyId),
    GoogleLead.aggregate([
      { $match: { ...tenant, isDeleted: false } },
      {
        $group: {
          _id: null,
          leads: { $sum: { $cond: ['$isTest', 0, 1] } },
          testLeads: { $sum: { $cond: ['$isTest', 1, 0] } },
          imported: { $sum: { $cond: ['$rawData.importedFromFile', 1, 0] } },
        },
      },
    ]),
    GoogleLead.aggregate([
      { $match: { ...tenant, isDeleted: false, isTest: false, formId: { $nin: ['', null] } } },
      {
        $group: {
          _id: '$formId',
          campaignId: { $last: '$campaignId' },
          leads: { $sum: 1 },
          lastLeadAt: { $max: '$createdAt' },
        },
      },
      { $sort: { lastLeadAt: -1 } },
      { $limit: MAX_FORMS_LISTED },
    ]),
    GoogleLead.findOne({ ...tenant, isTest: false, 'rawData.importedFromFile': { $ne: true } })
      .sort({ createdAt: -1 }).select('createdAt').lean(),
    GoogleLead.findOne({ ...tenant, isTest: true }).sort({ createdAt: -1 }).select('createdAt').lean(),
  ]);

  const counts = totals[0] || { leads: 0, testLeads: 0, imported: 0 };
  return {
    keySource: keyInfo.source,
    webhookKey: keyInfo.key,
    keyCreatedAt: keyInfo.createdAt,
    connected: Boolean(keyInfo.key) && Boolean(lastLead || lastTest),
    leads: counts.leads,
    testLeads: counts.testLeads,
    importedLeads: counts.imported,
    lastLeadAt: lastLead ? lastLead.createdAt : null,
    lastTestAt: lastTest ? lastTest.createdAt : null,
    forms: forms.map((form) => ({
      formId: form._id,
      campaignId: form.campaignId || '',
      leads: form.leads,
      lastLeadAt: form.lastLeadAt,
    })),
  };
};

// @desc    Google Ads integration status, webhook key and lead forms seen so far
// @route   GET /api/google-leads/integration
// @access  Private (admin, manager)
const getGoogleAdsIntegration = async (req, res) => {
  try {
    res.json(await loadStatus(req.leadsCompanyId));
  } catch (error) {
    serverError(res, error, 'Server error loading Google Ads integration');
  }
};

// @desc    Create (or replace) the webhook key. The old key stops working immediately.
// @route   POST /api/google-leads/integration/key
// @access  Private (admin, manager)
const createGoogleAdsKey = async (req, res) => {
  try {
    await generateWebhookKey(req.leadsCompanyId, req.user._id);
    log('GOOGLE_ADS_KEY_GENERATED', { userId: String(req.user._id) });
    res.json(await loadStatus(req.leadsCompanyId));
  } catch (error) {
    serverError(res, error, 'Server error creating the webhook key');
  }
};

// @desc    Disconnect: delete the CRM webhook key so Google Ads can no longer send leads.
//          Leads already received are kept.
// @route   DELETE /api/google-leads/integration/key
// @access  Private (admin, manager)
const deleteGoogleAdsKey = async (req, res) => {
  try {
    await removeWebhookKey(req.leadsCompanyId);
    log('GOOGLE_ADS_KEY_REMOVED', { userId: String(req.user._id) });
    res.json(await loadStatus(req.leadsCompanyId));
  } catch (error) {
    serverError(res, error, 'Server error disconnecting Google Ads');
  }
};

// @desc    Import leads from the file downloaded in Google Ads. Leads already in the CRM are skipped.
// @route   POST /api/google-leads/import
// @access  Private (admin, manager)
const importGoogleAdsLeads = async (req, res) => {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ message: 'Choose the leads file downloaded from Google Ads' });
  }
  const parsed = parseGoogleAdsLeadFile(req.file.buffer);
  if (!parsed.ok) return res.status(400).json({ message: parsed.message });

  // The same lead can appear twice in one file
  const seen = new Set();
  const unique = parsed.leads.filter((lead) => {
    if (seen.has(lead.externalLeadId)) return false;
    seen.add(lead.externalLeadId);
    return true;
  });

  try {
    const companyId = req.leadsCompanyId;
    const existing = await GoogleLead.find({
      company: companyId,
      externalLeadId: { $in: unique.map((lead) => lead.externalLeadId) },
    })
      .select('externalLeadId').lean();
    const existingIds = new Set(existing.map((lead) => lead.externalLeadId));
    const fresh = unique.filter((lead) => !existingIds.has(lead.externalLeadId));

    let imported = 0;
    if (fresh.length) {
      try {
        const inserted = await GoogleLead.insertMany(
          fresh.map((lead) => ({ ...lead, company: companyId })),
          { ordered: false }
        );
        imported = inserted.length;
      } catch (error) {
        // A webhook lead that arrived during the import is a duplicate, not a failure
        if (!error || error.code !== 11000) throw error;
        imported = (error.insertedDocs || []).length;
      }
    }

    const alreadyInCrm = parsed.leads.length - imported;
    log('GOOGLE_ADS_LEADS_IMPORTED', { userId: String(req.user._id), imported, alreadyInCrm });
    res.json({
      message: `${imported} lead(s) imported${alreadyInCrm ? `, ${alreadyInCrm} already in the CRM` : ''}${parsed.skipped ? `, ${parsed.skipped} empty row(s) skipped` : ''}`,
      imported,
      alreadyInCrm,
      skipped: parsed.skipped,
    });
  } catch (error) {
    serverError(res, error, 'Server error importing Google Ads leads');
  }
};

module.exports = {
  getGoogleAdsIntegration,
  createGoogleAdsKey,
  deleteGoogleAdsKey,
  importGoogleAdsLeads,
};

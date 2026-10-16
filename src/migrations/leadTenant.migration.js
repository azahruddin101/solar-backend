import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

// Lead assignments used to carry no company, so lookups by lead id could reach another company's rows.
// Every assignment now stores the company of its lead; copy it onto rows saved before the field existed.
// Rows whose lead no longer exists can't be attributed to any company and are removed.
export async function backfillLeadAssignmentCompany() {
  try {
    const assignments = mongoose.connection.collection('metaleadassignments');
    const missing = await assignments.find({ company: { $exists: false } }, { projection: { lead: 1 } }).toArray();
    if (!missing.length) return;
    const leadIds = [...new Set(missing.map((a) => String(a.lead)))].map((id) => new mongoose.Types.ObjectId(id));
    const leads = await mongoose.connection.collection('metaleads').find({ _id: { $in: leadIds } }, { projection: { company: 1 } }).toArray();
    const companyByLead = new Map(leads.filter((l) => l.company).map((l) => [String(l._id), l.company]));
    const ops = [];
    let orphans = 0;
    for (const a of missing) {
      const company = companyByLead.get(String(a.lead));
      if (company) ops.push({ updateOne: { filter: { _id: a._id }, update: { $set: { company } } } });
      else {
        orphans += 1;
        ops.push({ deleteOne: { filter: { _id: a._id } } });
      }
    }
    if (ops.length) await assignments.bulkWrite(ops, { ordered: false });
    logger.info('Lead assignments: company backfilled', { updated: missing.length - orphans, removedOrphans: orphans });
  } catch (e) {
    logger.warn(`Could not backfill the company on lead assignments: ${e.message}`);
  }
}

// One Facebook Page can be connected to only one company: the webhook routes a Page's leads by its id,
// so two companies on the same Page would receive each other's leads.
export async function ensureUniqueMetaPage() {
  try {
    const integrations = mongoose.connection.collection('metaintegrations');
    const dupes = await integrations.aggregate([
      { $match: { connected: true, selectedPageId: { $type: 'string', $ne: '' } } },
      { $group: { _id: '$selectedPageId', n: { $sum: 1 }, companies: { $push: '$company' } } },
      { $match: { n: { $gt: 1 } } },
    ]).toArray();
    if (dupes.length) {
      // Don't guess which company owns the Page: leave the data alone, refuse those webhooks (see
      // metaWebhookController) and tell the operator to disconnect the wrong one.
      logger.warn('One Facebook Page is connected to several companies; its leads are refused until only one remains connected', {
        pages: dupes.map((d) => ({ pageId: d._id, companies: d.companies.map(String) })),
      });
      return;
    }
    await integrations.createIndex(
      { selectedPageId: 1 },
      { name: 'selectedPageId_connected_unique', unique: true, partialFilterExpression: { connected: true, selectedPageId: { $type: 'string', $gt: '' } } },
    );
  } catch (e) {
    logger.warn(`Could not add the one-company-per-Facebook-Page index: ${e.message}`);
  }
}

import { Company, Design, Subsidy } from '../models/index.js';
import { DEFAULT_SUBSIDY_STEPS } from '../constants/index.js';
import { openSubsidyForDesign } from '../services/subsidy.service.js';

// Subsidy management arrived after proposals could already be marked "subsidy": give every company that has no subsidy
// step list yet the usual steps, then open a subsidy file for every proposal that already has the subsidy option on.
// Safe to run on every start: companies that have steps, and proposals that have a file, are left alone.
export async function migrateSubsidies() {
  try {
    await Subsidy.createIndexes();
    await Company.collection.updateMany(
      { $or: [{ subsidySteps: { $exists: false } }] },
      { $set: { subsidySteps: DEFAULT_SUBSIDY_STEPS.map((s) => ({ ...s })) } },
    );
    const withFile = await Subsidy.distinct('design');
    const missing = await Design.find({ 'subsidy.enabled': true, _id: { $nin: withFile } }).select('company client subsidy');
    const companies = new Map();
    for (const design of missing) {
      const key = String(design.company);
      if (!companies.has(key)) companies.set(key, await Company.findById(design.company).select('subsidySteps'));
      if (companies.get(key)) await openSubsidyForDesign(companies.get(key), design, null);
    }
  } catch (e) {
    console.warn(`Could not migrate subsidies: ${e.message}`);
  }
}

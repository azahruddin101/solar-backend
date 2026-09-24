// What a company owner receives about their own company. It is an allow-list, so a field added to the Company model
// stays private until someone deliberately lists it here (tests/companyView.test.js forces that decision).
import { subscriptionView } from '../services/subscription.service.js';

/** Fields the owner's screens use. */
export const OWNER_VISIBLE = [
  'id', 'name', 'email', 'phone', 'address', 'website', 'taxId', 'pan', 'status',
  'limits', 'subscription', 'features',
  'theme', 'logo', 'signature', 'qr', 'signatoryName', 'signatoryTitle', 'qrLabel', 'tagline', 'pdfTerms',
  'installationSteps', 'currency', 'tariff', 'otherCostPerKw', 'productUnits', 'agentRoles',
  'createdAt', 'updatedAt',
];

/** Fields that exist on the model but belong to the platform administrator (or are internal). */
export const ADMIN_ONLY = ['notes', 'plan', 'planRef'];

const pickOwnerFields = (json) => Object.fromEntries(OWNER_VISIBLE.filter((k) => json[k] !== undefined).map((k) => [k, json[k]]));

/** The owner's company object: allow-listed company fields plus the subscription/limits summary. */
export async function ownerCompanyView(company) {
  const json = company.toJSON ? company.toJSON() : company;
  return { ...pickOwnerFields(json), billing: await subscriptionView(company) };
}

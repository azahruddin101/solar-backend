// "Refer someone" in the client portal: a client fills in the company's own lead form (Name, Phone, Address and
// the fields the company added) for someone who may want solar. That person becomes a lead of the client's company
// (a manual lead with source "referral", carrying who referred them), worked like any other lead.
// The client is told two things about it and nothing else: that it was converted, or that it was lost.
import { Client, Company } from '../models/index.js'; // the app's own models first: the leads module reuses them
import { leadForm, leadModels } from '../integrations/leads.js';
import { HttpError, badRequest, conflict, notFound } from '../utils/HttpError.js';
import { notifyReferralAdded, notifyReferralOutcome } from './notification.service.js';

const clip = (v, max) => String(v ?? '').trim().slice(0, max);
const phoneKeyOf = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

/** What the client sees of a referral: who, when, and only "in progress", "converted" or "lost". */
const view = (lead) => ({
  id: String(lead._id),
  name: lead.fullName,
  phone: lead.phone,
  createdAt: lead.createdAt,
  outcome: lead.referralOutcome || 'open',
  outcomeAt: lead.referralOutcome ? lead.referralOutcomeAt : null,
});

const clientOf = async (user) => {
  const client = await Client.findOne({ _id: user.client, company: user.company }).select('name phone email').lean();
  if (!client) throw notFound('Client');
  return client;
};

/** The company's lead form. `company` is the request's company (with the organization's shared settings applied). */
const formFor = async (user, company) => leadForm.formOf(company || (await Company.findById(user.company)));

/** The form a client fills in to refer someone: the same one the company's staff use to add a lead. */
export async function referralForm(user, company = null) {
  return { fields: await formFor(user, company) };
}

/** The people this client referred, newest first. */
export async function listReferrals(user) {
  const rows = await leadModels.manual.find({ company: user.company, referredByClient: user.client, isDeleted: { $ne: true } })
    .select('fullName phone createdAt referralOutcome referralOutcomeAt').sort({ createdAt: -1 }).limit(200).lean();
  return rows.map(view);
}

/**
 * A client refers someone: the body carries the company's lead form by field key (name, phone, address and the
 * company's own fields), checked exactly as when staff add a lead, plus an optional `note` for the company.
 */
export async function createReferral(user, body = {}, company = null) {
  const client = await clientOf(user);
  const form = await formFor(user, company);
  const { values, errors } = leadForm.cleanLeadValues(form, body);
  if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors)[0], undefined, { errors }); // per field, for the form
  const note = clip(body.note, 300);
  const phoneKey = phoneKeyOf(values.phone);
  if (phoneKey.length < 7) throw new HttpError(400, 'Enter their mobile number', undefined, { errors: { phone: 'Enter their mobile number' } });
  // the company may know this person already (from this client, another one, or its own leads)
  const known = await leadModels.manual.findOne({ company: user.company, phoneKey, isDeleted: { $ne: true } }).select('referredByClient').lean();
  if (known) throw conflict(String(known.referredByClient || '') === String(user.client) ? 'You have already referred this person.' : 'Thank you! We already have this person’s details.');
  const answers = form.filter((f) => !leadForm.FIXED_KEYS.includes(f.key)).map((f) => leadForm.valueText(f, values.fields[f.key]));
  const lead = await leadModels.manual.create({
    company: user.company,
    source: 'referral',
    fullName: values.name,
    phone: values.phone,
    phoneKey,
    address: values.address || '',
    fields: values.fields,
    searchText: [values.name, values.phone, values.address, ...answers, client.name].filter(Boolean).join(' ').toLowerCase().slice(0, 2000),
    createdBy: user._id,
    createdByName: `${client.name} (client)`,
    // who referred them, kept with the lead: the client record and their contact as it is today
    referredByClient: user.client,
    referredByClientName: client.name,
    referredByClientPhone: client.phone || '',
    referredByClientEmail: client.email || '',
    logs: [{ action: 'referral', message: `Referred by client ${client.name}${note ? `: ${note}` : ''}`, byName: client.name }],
  });
  notifyReferralAdded({ companyId: String(user.company), leadId: String(lead._id), clientName: client.name, name: values.name, actorId: String(user._id) });
  return view(lead.toObject());
}

/**
 * Called after a manual lead's status changed. For a referral: when the lead has just reached the company's
 * converted or lost status, the client who referred it is told (once for each); any other status is the company's
 * own business and the client hears nothing. A lead moved back to an open status counts as in progress again.
 */
export async function syncReferralOutcome(companyId, leadId) {
  const Lead = leadModels.manual;
  const lead = await Lead.findOne({ _id: leadId, company: companyId, source: 'referral', referredByClient: { $ne: null } }).select('fullName status referredByClient referralOutcome').lean();
  if (!lead) return null;
  const status = lead.status ? await leadModels.status.findOne({ _id: lead.status, company: companyId }).select('outcome isConversion').lean() : null;
  const outcome = status?.outcome === 'converted' || status?.isConversion ? 'converted' : status?.outcome === 'lost' ? 'lost' : '';
  if (outcome === (lead.referralOutcome || '')) return null;
  // only the request that makes the change tells the client (two at once cannot both)
  const changed = await Lead.updateOne({ _id: lead._id, company: companyId, referralOutcome: lead.referralOutcome || '' }, { $set: { referralOutcome: outcome, referralOutcomeAt: outcome ? new Date() : null } });
  if (!changed.modifiedCount || !outcome) return outcome;
  notifyReferralOutcome({ companyId: String(companyId), clientId: String(lead.referredByClient), leadId: String(lead._id), name: lead.fullName, outcome });
  return outcome;
}

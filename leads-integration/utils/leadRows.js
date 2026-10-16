// A company's leads as spreadsheet rows — the export (Excel / CSV) and the company's Google Sheet share these columns.
const MetaLead = require('../models/MetaLead');
const GoogleLead = require('../models/GoogleLead');
const ManualLead = require('../models/ManualLead');
const MetaLeadAssignment = require('../models/MetaLeadAssignment');
const { MAX_EXPORT_ROWS } = require('./leadExport');
const { formatSheetDate } = require('./leadSheetRows');
const { FIXED_KEYS, formOf, valueText } = require('./leadForm');
const { leadCompanyFilter } = require('./tenant');

// The same columns for every source; then the company's own lead-form fields (filled for manual leads); then any
// other answers from Meta / Google forms, in one column, so the sheet stays tidy whatever those forms ask.
const BASE_HEADERS = ['Source', 'Name', 'Phone', 'Email', 'Address', 'Received', 'Status', 'Assigned to'];
const SOURCE_LABEL = { meta: 'Meta', google: 'Google Ads', manual: 'Added', import: 'Imported' };

const text = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean).join(', ') : v == null ? '' : String(v).trim());
// answers of a Meta / Google form that already have their own column
const COVERED = /^(full ?name|first ?name|last ?name|name|e-?mail|email ?address|phone|phone ?number|mobile|work ?phone|street ?address|address ?line ?\d?|full ?address|address|city|town|district|state|province|region|country|zip|zip ?code|post ?code|postcode|postal ?code|pin ?code|pincode|location)$/i;
const fieldLabel = (key) => String(key).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
const pick = (fields, ...keys) => {
  const entries = Object.entries(fields || {});
  for (const k of keys) {
    const hit = entries.find(([key]) => key.toLowerCase() === k);
    if (hit && text(hit[1])) return text(hit[1]);
  }
  return '';
};
/** A full address answer if the form had one, otherwise its parts (city, state, postal code…) joined. */
const ADDRESS_PART = /^(street ?address|address ?line ?\d?|city|town|district|state|province|region|country|zip|zip ?code|post ?code|postcode|postal ?code|pin ?code|pincode|location)$/i;
const addressFrom = (fields) => {
  const entries = Object.entries(fields || {}).map(([k, v]) => [String(k).replace(/[_]+/g, ' ').trim(), text(v)]).filter(([, v]) => v);
  const full = entries.find(([k]) => /^(full ?address|address)$/i.test(k));
  if (full) return full[1];
  return entries.filter(([k]) => ADDRESS_PART.test(k)).map(([, v]) => v).join(', ');
};

/** "City: Pune; Budget: 3 lakh" — everything a Meta / Google form asked beyond name, phone, email and address. */
const otherAnswers = (fields) => Object.entries(fields || {})
  .filter(([key, v]) => !COVERED.test(String(key).replace(/[_]+/g, ' ').trim()) && text(v))
  .map(([key, v]) => `${fieldLabel(key)}: ${text(v)}`)
  .join('; ');

/**
 * A company's leads as rows (header row first), newest first: Meta, Google Ads and manual leads in the same columns,
 * then the company's lead-form fields, then other form answers (unless `otherAnswers: false`). `scope` narrows it
 * (e.g. staff who see only theirs).
 * Used by the Excel/CSV export and by the company's Google Sheet.
 */
async function collectLeadRows({ companyId, company, scope: extra = {}, otherAnswers: withOther = true }) {
  const scope = { ...leadCompanyFilter(companyId), ...extra };
  const [metaLeads, googleLeads, manualLeads] = await Promise.all([
    MetaLead.find({ ...scope, isDeleted: false, processingStatus: 'processed' })
      .select('fullName email phone fields leadCreatedAt createdAt assignedTo adminStatus')
      .populate('assignedTo', 'name')
      .populate('adminStatus', 'name')
      .sort({ leadCreatedAt: -1 })
      .limit(MAX_EXPORT_ROWS)
      .lean(),
    GoogleLead.find({ ...scope, isDeleted: false })
      .select('fullName email phone fields createdAt assignedTo statusName')
      .populate('assignedTo', 'name')
      .sort({ createdAt: -1 })
      .limit(MAX_EXPORT_ROWS)
      .lean(),
    ManualLead.find({ ...scope, isDeleted: false })
      .select('fullName phone address fields source createdAt assignedTo statusName')
      .populate('assignedTo', 'name')
      .sort({ createdAt: -1 })
      .limit(MAX_EXPORT_ROWS)
      .lean(),
  ]);

  // a Meta lead's status is its current owner's; before anyone owns it, the one set on the lead
  const owned = await MetaLeadAssignment.find({ ...leadCompanyFilter(companyId), lead: { $in: metaLeads.map((l) => l._id) }, isActive: true })
    .select('lead currentStatus')
    .populate('currentStatus', 'name')
    .lean();
  const statusByLead = new Map(owned.map((a) => [String(a.lead), a.currentStatus?.name || '']));

  const custom = formOf(company).filter((f) => !FIXED_KEYS.includes(f.key));
  const fromForm = (lead, source, status) => ({
    source,
    name: text(lead.fullName) || [pick(lead.fields, 'first_name', 'first name'), pick(lead.fields, 'last_name', 'last name')].filter(Boolean).join(' ') || pick(lead.fields, 'full_name', 'name'),
    phone: text(lead.phone) || pick(lead.fields, 'phone_number', 'phone', 'mobile'),
    email: text(lead.email) || pick(lead.fields, 'email'),
    address: text(lead.address) || addressFrom(lead.fields),
    receivedAt: lead.leadCreatedAt || lead.createdAt,
    status,
    assignedTo: lead.assignedTo?.name || '',
    custom: custom.map(() => ''),
    other: otherAnswers(lead.fields),
  });
  const rows = [
    ...metaLeads.map((lead) => fromForm(lead, 'meta', statusByLead.get(String(lead._id)) || lead.adminStatus?.name || '')),
    ...googleLeads.map((lead) => fromForm(lead, 'google', lead.statusName || '')),
    ...manualLeads.map((lead) => ({
      ...fromForm({ ...lead, fields: {} }, lead.source === 'import' ? 'import' : 'manual', lead.statusName || ''),
      // a manual lead's answers belong to the company's own fields
      custom: custom.map((f) => valueText(f, lead.fields?.[f.key])),
      email: custom.filter((f) => f.type === 'email').map((f) => text(lead.fields?.[f.key])).find(Boolean) || '',
    })),
  ];
  rows.sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));
  if (rows.length > MAX_EXPORT_ROWS) rows.length = MAX_EXPORT_ROWS;
  // the Google Sheet leaves this column out (withOther false); the export keeps it
  const anyOther = withOther && rows.some((r) => r.other);
  const headers = [...BASE_HEADERS, ...custom.map((f) => f.label), ...(anyOther ? ['Other answers'] : [])];
  return [headers, ...rows.map((r) => [
    SOURCE_LABEL[r.source], r.name, r.phone, r.email, r.address, formatSheetDate(r.receivedAt), r.status, r.assignedTo,
    ...r.custom,
    ...(anyOther ? [r.other] : []),
  ])];
}

// A cell a spreadsheet would run as a formula (=…, @…, or +/- followed by anything but a plain number) is prefixed
// so it stays plain text. Phone numbers such as "+91 98765 43210" are left as they are.
const safeCell = (value) => {
  const text = String(value ?? '');
  return /^[=@\t\r]/.test(text) || /^[+-](?![\d\s().]*$)/.test(text) ? `'${text}` : text;
};

module.exports = { collectLeadRows, safeCell, BASE_HEADERS };

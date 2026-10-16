const SHEET_HEADERS = ['Name', 'Email', 'Phone', 'Qualification', 'Address', 'Date', 'Source'];

const ADDRESS_KEY = /(^|_)(street_address|full_address|address|city|state|zip_code|zip|post_code|postcode|pincode|pin_code|location)($|_)/i;
const QUALIFICATION_KEY = /qualification|education|degree/i;
const SHEET_TIME_ZONE = 'Asia/Kolkata';

const textValue = (value) => {
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(', ');
  if (value == null) return '';
  return String(value).trim();
};

// Pull an address out of a Meta or Google form, which stores each answer under its question key.
const addressFromFields = (fields) => {
  if (!fields || typeof fields !== 'object') return '';
  const entries = Object.entries(fields);
  const exact = entries.find(([key]) => /^(street_address|full_address|address)$/i.test(key));
  const exactText = exact ? textValue(exact[1]) : '';
  if (exactText) return exactText;

  const parts = [];
  entries.forEach(([key, value]) => {
    if (!ADDRESS_KEY.test(key)) return;
    const text = textValue(value);
    if (text) parts.push(text);
  });
  return parts.join(', ');
};

// Custom form questions are keyed by their wording, e.g. "highest_qualification".
const qualificationFromFields = (fields) => {
  if (!fields || typeof fields !== 'object') return '';
  const match = Object.entries(fields).find(([key, value]) => QUALIFICATION_KEY.test(key) && textValue(value));
  return match ? textValue(match[1]) : '';
};

// Source values: added (staff form), uploaded (spreadsheet import), website, meta, google.
const sourceFor = (channel, lead) => {
  if (channel === 'manual') return lead && lead.source === 'upload' ? 'uploaded' : 'added';
  if (channel === 'meta') return 'meta';
  if (channel === 'google') return 'google';
  if (channel === 'website') return 'website';
  return '';
};

const formatSheetDate = (value) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: SHEET_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

// `fallback` holds the address / qualification found on the linked registration record.
const describeLead = (channel, lead, fallback = {}) => {
  const createdAt = lead && (lead.leadCreatedAt || lead.createdAt);
  return {
    name: textValue((lead && (lead.fullName || lead.name)) || ''),
    email: textValue(lead && lead.email),
    phone: textValue(lead && lead.phone),
    qualification: textValue(lead && lead.qualification)
      || qualificationFromFields(lead && lead.fields)
      || textValue(fallback.qualification),
    address: textValue(lead && lead.address)
      || addressFromFields(lead && lead.fields)
      || textValue(fallback.address),
    date: formatSheetDate(createdAt),
    source: sourceFor(channel, lead),
    sortAt: new Date(createdAt || 0).getTime() || 0,
  };
};

const toSheetValues = (rows) => [
  SHEET_HEADERS,
  ...rows.map((row) => [row.name, row.email, row.phone, row.qualification, row.address, row.date, row.source]),
];

module.exports = {
  SHEET_HEADERS,
  addressFromFields,
  qualificationFromFields,
  formatSheetDate,
  describeLead,
  toSheetValues,
};

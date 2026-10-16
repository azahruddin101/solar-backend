const crypto = require('crypto');
const XLSX = require('xlsx');
const { buildSearchText } = require('./leadSearchText');

// Reads the lead file downloaded from Google Ads (Assets > Lead forms > Download leads),
// or any CSV / Excel with similar headings. Column names differ between Google Ads
// exports and languages, so each standard field accepts several headings; every other
// column (custom questions) is kept in `fields` under its heading.

const MAX_ROWS = 5000;
const MAX_FIELD_VALUE_LENGTH = 2000;

const HEADINGS = {
  leadId: ['lead id', 'lead_id', 'id'],
  fullName: ['full name', 'full_name', 'name', 'user name'],
  firstName: ['first name', 'first_name', 'given name'],
  lastName: ['last name', 'last_name', 'family name', 'surname'],
  email: ['email', 'user email', 'email address', 'e-mail', 'work email'],
  phone: ['phone number', 'phone', 'phone_number', 'user phone', 'mobile', 'mobile number', 'work phone'],
  submittedAt: ['submit time', 'submission time', 'lead submit time', 'submitted at', 'submission date', 'date', 'created', 'created time', 'lead_submit_time'],
  campaignId: ['campaign id', 'campaign_id'],
  formId: ['form id', 'form_id', 'lead form id'],
  adGroupId: ['ad group id', 'adgroup id', 'adgroup_id', 'ad_group_id'],
  creativeId: ['creative id', 'creative_id', 'ad id'],
  gclId: ['gclid', 'gcl id', 'gcl_id', 'google click id'],
};

const normalizeHeading = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const fieldKey = (heading, index) => (
  String(heading || '').trim().replace(/\./g, '_').replace(/^[$_]+/, '') || `field_${index + 1}`
);

const parseDate = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 86400000 ? null : date;
};

const parseGoogleAdsLeadFile = (buffer) => {
  let book;
  try {
    book = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch (error) {
    return { ok: false, message: 'Could not read this file. Upload the CSV downloaded from Google Ads.' };
  }
  const sheetName = book.SheetNames[0];
  if (!sheetName) return { ok: false, message: 'The file is empty' };

  const rows = XLSX.utils.sheet_to_json(book.Sheets[sheetName], { header: 1, defval: '', raw: false });
  if (rows.length < 2) return { ok: false, message: 'The file has no leads' };

  const headings = rows[0].map(normalizeHeading);
  const columnOf = {};
  Object.entries(HEADINGS).forEach(([field, names]) => {
    const index = headings.findIndex((heading) => names.includes(heading));
    if (index !== -1) columnOf[field] = index;
  });

  const hasName = columnOf.fullName !== undefined || columnOf.firstName !== undefined;
  if (!hasName && columnOf.email === undefined && columnOf.phone === undefined) {
    return { ok: false, message: 'No name, email or phone column was found. Upload the leads file downloaded from Google Ads.' };
  }

  const dataRows = rows.slice(1).filter((row) => row.some((cell) => String(cell || '').trim()));
  if (dataRows.length > MAX_ROWS) {
    return { ok: false, message: `The file has ${dataRows.length} leads. Upload at most ${MAX_ROWS} at a time.` };
  }

  const known = new Set(Object.values(columnOf));
  const leads = [];
  let skipped = 0;

  dataRows.forEach((row) => {
    const cell = (field) => (columnOf[field] === undefined ? '' : String(row[columnOf[field]] || '').trim());
    const fullName = cell('fullName') || [cell('firstName'), cell('lastName')].filter(Boolean).join(' ');
    const email = cell('email');
    const phone = cell('phone');
    if (!fullName && !email && !phone) {
      skipped += 1;
      return;
    }

    const fields = {};
    headings.forEach((heading, index) => {
      const value = String(row[index] || '').trim().slice(0, MAX_FIELD_VALUE_LENGTH);
      if (!value) return;
      // Standard columns keep Google's own ids so they match webhook leads
      if (index === columnOf.fullName) fields.FULL_NAME = value;
      else if (index === columnOf.firstName) fields.FIRST_NAME = value;
      else if (index === columnOf.lastName) fields.LAST_NAME = value;
      else if (index === columnOf.email) fields.EMAIL = value;
      else if (index === columnOf.phone) fields.PHONE_NUMBER = value;
      else if (!known.has(index)) fields[fieldKey(rows[0][index], index)] = value;
    });

    const submittedAt = parseDate(cell('submittedAt'));
    // Without a lead id, the same person on the same date counts as the same lead
    const leadId = cell('leadId')
      || `import-${crypto.createHash('sha256')
        .update([fullName, email, phone, submittedAt ? submittedAt.toISOString() : ''].join('|').toLowerCase())
        .digest('hex')
        .slice(0, 32)}`;

    leads.push({
      externalLeadId: leadId,
      formId: cell('formId'),
      campaignId: cell('campaignId'),
      adGroupId: cell('adGroupId'),
      creativeId: cell('creativeId'),
      gclId: cell('gclId'),
      fullName,
      email,
      phone,
      fields,
      searchText: buildSearchText(...Object.values(fields)).slice(0, 2000),
      rawData: { importedFromFile: true },
      ...(submittedAt ? { createdAt: submittedAt } : {}),
    });
  });

  return { ok: true, leads, skipped };
};

module.exports = { parseGoogleAdsLeadFile, MAX_ROWS };

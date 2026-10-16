// The lead form a company uses for leads added by hand or imported from a spreadsheet ("Manual leads").
// Name, Phone and Address are on every company's form; each company adds its own fields after them
// (Manage Masters → Lead form). The same rules check the form itself and every value typed into it.

const FIELD_TYPES = ['text', 'textarea', 'number', 'phone', 'email', 'select', 'multiselect', 'date', 'yesno'];
const FIELD_TYPE_LABEL = {
  text: 'Short text',
  textarea: 'Long text',
  number: 'Number',
  phone: 'Phone',
  email: 'Email',
  select: 'Dropdown',
  multiselect: 'Multiple choice',
  date: 'Date',
  yesno: 'Yes / No',
};
const WITH_OPTIONS = ['select', 'multiselect'];

/** On every company's form, always first, can't be removed. */
const FIXED_FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true, fixed: true },
  { key: 'phone', label: 'Phone', type: 'phone', required: true, fixed: true },
  { key: 'address', label: 'Address', type: 'textarea', required: false, fixed: true },
];
const FIXED_KEYS = FIXED_FIELDS.map((f) => f.key);

const MAX_FIELDS = 40;
const MAX_OPTIONS = 50;
const LIMITS = { text: 200, textarea: 2000, name: 120 };

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

class LeadFormError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** "Monthly bill (₹)" → "monthly_bill" — the field's storage key, fixed once the field exists. */
const keyFromLabel = (label) => clean(label, 60).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';

/**
 * A company's custom fields, checked and tidied. `previous` is the saved form: a field sent with an existing `key`
 * keeps it (so leads already holding answers stay linked); new fields get a key from their label.
 */
function parseLeadForm(raw, previous = []) {
  if (!Array.isArray(raw)) throw new LeadFormError('The form must be a list of fields');
  if (raw.length > MAX_FIELDS) throw new LeadFormError(`A form can have up to ${MAX_FIELDS} fields of your own`);
  const known = new Set(previous.map((f) => f.key));
  const taken = new Set(FIXED_KEYS);
  const labels = new Set(FIXED_FIELDS.map((f) => f.label.toLowerCase()));
  return raw.map((f, i) => {
    const label = clean(f?.label, 60);
    if (!label) throw new LeadFormError(`Field ${i + 1} needs a name`);
    if (labels.has(label.toLowerCase())) throw new LeadFormError(`There's already a field called “${label}”`);
    labels.add(label.toLowerCase());
    const type = FIELD_TYPES.includes(f?.type) ? f.type : null;
    if (!type) throw new LeadFormError(`Choose a type for “${label}”`);
    let key = typeof f?.key === 'string' && known.has(f.key) && !taken.has(f.key) ? f.key : keyFromLabel(label);
    for (let n = 2; taken.has(key); n += 1) key = `${keyFromLabel(label)}_${n}`;
    taken.add(key);
    const field = { key, label, type, required: f?.required === true, help: clean(f?.help, 200) };
    if (WITH_OPTIONS.includes(type)) {
      const options = [...new Set((Array.isArray(f?.options) ? f.options : []).map((o) => clean(o, 60)).filter(Boolean))];
      if (!options.length) throw new LeadFormError(`Add at least one choice to “${label}”`);
      if (options.length > MAX_OPTIONS) throw new LeadFormError(`“${label}” can have up to ${MAX_OPTIONS} choices`);
      field.options = options;
    } else {
      field.options = [];
    }
    return field;
  });
}

/** The whole form of a company: the fixed fields, then its own. */
const formOf = (company) => [...FIXED_FIELDS, ...((company && company.leadForm) || []).map((f) => ({ key: f.key, label: f.label, type: f.type, required: Boolean(f.required), help: f.help || '', options: f.options || [] }))];

const PHONE = /^\+?[0-9][0-9\s-]{5,19}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const YES = ['yes', 'y', 'true', '1'];
const NO = ['no', 'n', 'false', '0'];

/** Excel gives dates as serial numbers; people type 2026-10-16, 16/10/2026 or 16-10-2026. */
function toIsoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && value > 20000 && value < 80000) return new Date(Math.round((value - 25569) * 86400000)).toISOString().slice(0, 10);
  const s = String(value ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s); // day first, as written in India
  if (m) return valid(+m[3], +m[2], +m[1]);
  return null;
  function valid(y, mo, d) {
    const date = new Date(Date.UTC(y, mo - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
  }
}

/** One value for one field: [cleaned value | undefined when empty, error message | null]. */
function cleanValue(field, raw) {
  const empty = raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim()) || (Array.isArray(raw) && !raw.length);
  if (empty) return [undefined, field.required ? `${field.label} is required` : null];
  switch (field.type) {
    case 'text': return [clean(raw, field.key === 'name' ? LIMITS.name : LIMITS.text), null];
    case 'textarea': return [String(raw).trim().slice(0, LIMITS.textarea), null];
    case 'number': {
      const n = Number(String(raw).replace(/,/g, '').trim());
      return Number.isFinite(n) ? [n, null] : [undefined, `${field.label} must be a number`];
    }
    case 'phone': {
      const p = String(raw).trim();
      return PHONE.test(p) ? [p.replace(/\s+/g, ' '), null] : [undefined, `${field.label} isn't a valid phone number`];
    }
    case 'email': {
      const e = String(raw).trim().toLowerCase();
      return EMAIL.test(e) && e.length <= 200 ? [e, null] : [undefined, `${field.label} isn't a valid email`];
    }
    case 'select': {
      const v = String(raw).trim();
      const hit = field.options.find((o) => o.toLowerCase() === v.toLowerCase());
      return hit ? [hit, null] : [undefined, `${field.label}: choose one of ${field.options.join(', ')}`];
    }
    case 'multiselect': {
      const list = (Array.isArray(raw) ? raw : String(raw).split(/[,;]/)).map((x) => String(x).trim()).filter(Boolean);
      const picked = [];
      for (const v of list) {
        const hit = field.options.find((o) => o.toLowerCase() === v.toLowerCase());
        if (!hit) return [undefined, `${field.label}: “${v}” isn't one of the choices`];
        if (!picked.includes(hit)) picked.push(hit);
      }
      return picked.length ? [picked, null] : [undefined, field.required ? `${field.label} is required` : null];
    }
    case 'date': {
      const d = toIsoDate(raw);
      return d ? [d, null] : [undefined, `${field.label} isn't a valid date`];
    }
    case 'yesno': {
      if (typeof raw === 'boolean') return [raw, null];
      const v = String(raw).trim().toLowerCase();
      if (YES.includes(v)) return [true, null];
      if (NO.includes(v)) return [false, null];
      return [undefined, `${field.label} must be Yes or No`];
    }
    default: return [undefined, null];
  }
}

/**
 * The values of one lead against the company's form: { values: { name, phone, address, fields }, errors }.
 * `errors` maps a field key to its message (empty when everything is fine). Unknown keys are ignored.
 */
function cleanLeadValues(form, input = {}) {
  const errors = {};
  const out = { fields: {} };
  for (const field of form) {
    const [value, error] = cleanValue(field, input[field.key]);
    if (error) errors[field.key] = error;
    else if (FIXED_KEYS.includes(field.key)) out[field.key] = value ?? '';
    else if (value !== undefined) out.fields[field.key] = value;
  }
  return { values: out, errors };
}

/** A value as text, for search, the table and the export. */
const valueText = (field, value) => {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return value.join(', ');
  if (field?.type === 'yesno') return value ? 'Yes' : 'No';
  return String(value);
};

module.exports = { FIELD_TYPES, FIELD_TYPE_LABEL, FIXED_FIELDS, FIXED_KEYS, MAX_FIELDS, LeadFormError, parseLeadForm, formOf, cleanLeadValues, cleanValue, valueText, toIsoDate };

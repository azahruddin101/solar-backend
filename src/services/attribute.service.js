// Category attribute definitions and the product values they describe. A category lists its attributes
// (Category.attributes); a product stores the values as { [key]: value } (Product.attributes). Checked here on the
// server, not only in the form: required values, numbers, and the allowed options of a select.
import { ATTRIBUTE_TYPES } from '../constants/index.js';
import { badRequest } from '../utils/HttpError.js';

export const MAX_ATTRIBUTES = 40;
const MAX_OPTIONS = 50;
const MAX_TEXT = 200;

/** "Efficiency (%)" → "efficiency", "MPPT count" → "mpptCount": a stable key made from the label. */
export function attributeKey(label) {
  const words = String(label ?? '').replace(/\([^)]*\)/g, ' ').toLowerCase().match(/[a-z0-9]+/g) || [];
  const key = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('').slice(0, 40);
  return /^[0-9]/.test(key) ? `a${key}`.slice(0, 40) : key;
}

/**
 * The definitions from the category form, cleaned: a key for each (kept when given, so renaming a label doesn't orphan
 * stored values), no repeated keys, options only on selects, and sortOrder following the list order unless given.
 */
export function cleanAttributeDefs(defs) {
  if (!Array.isArray(defs)) throw badRequest('Invalid attributes');
  const out = [];
  const seen = new Set();
  for (const [i, d] of defs.entries()) {
    const label = String(d?.label ?? '').trim();
    if (!label) continue;
    const key = String(d?.key ?? '').trim() || attributeKey(label);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) throw badRequest(`“${label}” needs a key made of letters and digits`);
    if (seen.has(key.toLowerCase())) throw badRequest(`“${label}” is listed twice in the attributes`);
    seen.add(key.toLowerCase());
    const dataType = d?.dataType ?? 'text';
    if (!ATTRIBUTE_TYPES.includes(dataType)) throw badRequest(`“${label}” has an invalid type`);
    const options = dataType === 'select' ? [...new Set((Array.isArray(d?.options) ? d.options : []).map((o) => String(o ?? '').trim()).filter(Boolean))] : [];
    if (dataType === 'select' && !options.length) throw badRequest(`Add at least one option to “${label}”`);
    if (options.length > MAX_OPTIONS) throw badRequest(`“${label}” can have up to ${MAX_OPTIONS} options`);
    const sortOrder = Number.isFinite(Number(d?.sortOrder)) && d?.sortOrder !== '' && d?.sortOrder != null ? Number(d.sortOrder) : i + 1;
    out.push({ key, label: label.slice(0, 60), dataType, isRequired: Boolean(d?.isRequired), options, sortOrder });
  }
  if (out.length > MAX_ATTRIBUTES) throw badRequest(`A category can have up to ${MAX_ATTRIBUTES} attributes`);
  return out.sort((a, b) => a.sortOrder - b.sortOrder);
}

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** One value as its definition's type; throws a readable error when it doesn't fit. */
function coerce(def, raw) {
  switch (def.dataType) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/,/g, ''));
      if (!Number.isFinite(n)) throw badRequest(`${def.label} must be a number`);
      return n;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (/^(true|yes|1)$/i.test(String(raw).trim())) return true;
      if (/^(false|no|0)$/i.test(String(raw).trim())) return false;
      throw badRequest(`${def.label} must be yes or no`);
    case 'select': {
      const match = def.options.find((o) => o.toLowerCase() === String(raw).trim().toLowerCase());
      if (!match) throw badRequest(`${def.label} must be one of: ${def.options.join(', ')}`);
      return match;
    }
    default: {
      const s = String(raw).trim();
      if (s.length > MAX_TEXT) throw badRequest(`${def.label} can be at most ${MAX_TEXT} characters`);
      return s;
    }
  }
}

/**
 * The product's attribute values checked against its category's definitions. Values for keys the category defines
 * are typed and validated (required ones must be filled); values the product already had for keys the category no
 * longer defines are kept as they are, so editing a category never loses product data. Unknown new keys are dropped.
 * @param {Array} defs category attribute definitions
 * @param {object} input the values sent with the product
 * @param {object} [existing] the product's stored values (on edit)
 */
export function validateAttributes(defs, input, existing = {}) {
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) throw badRequest('Invalid attributes');
  const values = input || {};
  const defined = new Set((defs || []).map((d) => d.key));
  const out = {};
  for (const [k, v] of Object.entries(existing || {})) if (!defined.has(k)) out[k] = v; // from attributes since removed
  for (const def of defs || []) {
    const raw = Object.hasOwn(values, def.key) ? values[def.key] : existing?.[def.key];
    if (blank(raw)) {
      if (def.isRequired) throw badRequest(`${def.label} is required`);
      continue;
    }
    out[def.key] = coerce(def, raw);
  }
  return out;
}

/** Text attributes from a list of labels (starter catalogs). */
export const textAttributes = (labels) => labels.map((label, i) => ({ key: attributeKey(label), label, dataType: 'text', isRequired: false, options: [], sortOrder: i + 1 }));

// Field rules shared by every schema. "Optional" here means: may be left blank, but if filled it must be valid.
// (The frontend has the same rules in frontend/src/lib/validation.js — keep the two in step.)
import { z } from 'zod';

// null → '' so a cleared field counts as blank; undefined (key absent) is left alone so partial updates stay partial
const blankToEmpty = (v) => (v === null ? '' : v);

/** A string field that may be empty; when not empty it must pass `check`. `transform` normalises first. */
function optional(check, message, { max = 200, transform = (v) => v } = {}) {
  return z
    .preprocess(
      blankToEmpty,
      z.string('Enter text').trim().max(max, `Too long (up to ${max} characters)`).transform(transform).refine((v) => v === '' || check(v), message),
    )
    .optional();
}
/** Same, but must be filled. */
function required(check, message, { max = 200, transform = (v) => v, blank = 'This field is required' } = {}) {
  return z.preprocess(
    blankToEmpty,
    z.string(blank).trim().min(1, blank).max(max, `Too long (up to ${max} characters)`).transform(transform).refine(check, message),
  );
}

/* ───────────── patterns ───────────── */

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
const validEmail = (v) => EMAIL.test(v) && !v.includes('..') && !v.startsWith('.') && !v.split('@')[0].endsWith('.');

/** A 10-digit Indian mobile (starting 6–9). A leading +91 / 91 / 0 and separators are accepted and dropped. */
const normalizePhone = (v) => {
  let p = v.replace(/[\s().+-]/g, '');
  if (p.length === 12 && p.startsWith('91')) p = p.slice(2);
  else if (p.length === 11 && p.startsWith('0')) p = p.slice(1);
  return p;
};
const validPhone = (v) => /^[6-9]\d{9}$/.test(v);

/** PAN: 5 letters, 4 digits, 1 letter; the 4th letter is the holder type (P person, C company, …). */
const validPan = (v) => /^[A-Z]{3}[ABCFGHJKLPT][A-Z]\d{4}[A-Z]$/.test(v);

/** GSTIN: state code (01–38), the holder's PAN, entity number, 'Z', check character. */
const validGstin = (v) => /^(0[1-9]|[12]\d|3[0-8])[A-Z]{3}[ABCFGHJKLPT][A-Z]\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v);

const validWebsite = (v) => {
  try {
    const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return /^https?:$/.test(url.protocol) && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname) && /[a-z]{2,}$/i.test(url.hostname);
  } catch {
    return false;
  }
};

const PERSON = /^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]*$/u;
const ORG = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}\s.,&'’()/+-]*$/u;

/* ───────────── text-like fields ───────────── */

export const emailRequired = required(validEmail, 'Enter a valid email address (like name@company.com)', { transform: (v) => v.toLowerCase(), blank: 'Email is required' });
export const emailOptional = optional(validEmail, 'Enter a valid email address (like name@company.com)', { transform: (v) => v.toLowerCase() });
export const phoneOptional = optional(validPhone, 'Enter a valid 10-digit mobile number (starting with 6, 7, 8 or 9)', { max: 20, transform: normalizePhone });
export const panOptional = optional(validPan, 'Enter a valid PAN, like ABCDE1234F', { max: 10, transform: (v) => v.toUpperCase() });
export const gstinOptional = optional(validGstin, 'Enter a valid 15-character GSTIN, like 27ABCDE1234F1Z5', { max: 15, transform: (v) => v.toUpperCase() });
export const websiteOptional = optional(validWebsite, 'Enter a valid website, like www.example.com');
export const personNameRequired = required((v) => v.length >= 2 && PERSON.test(v), 'Enter a valid name (letters only, at least 2)', { max: 120, blank: 'Name is required' });
export const personNameOptional = optional((v) => v.length >= 2 && PERSON.test(v), 'Enter a valid name (letters only, at least 2)', { max: 120 });
export const orgNameRequired = required((v) => v.length >= 2 && ORG.test(v), 'Enter a valid name', { max: 120, blank: 'Name is required' });
export const consumerNumberOptional = optional((v) => /^[A-Za-z0-9][A-Za-z0-9/-]{3,29}$/.test(v), 'Enter a valid consumer number (4–30 letters, digits, - or /)', { max: 30 });
export const skuOptional = optional((v) => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(v), 'SKU can only have letters, digits and . _ - /', { max: 60 });
export const hsnOptional = optional((v) => /^\d{4}(\d{2}(\d{2})?)?$/.test(v), 'HSN code must be 4, 6 or 8 digits', { max: 8 });
export const invoicePrefixOptional = optional((v) => /^[A-Za-z0-9/_.-]*$/.test(v), 'The fixed part can only have letters, digits and - / _ .', { max: 20 });
export const invoiceNextRequired = required((v) => /^\d{1,10}$/.test(v) && Number(v) >= 1, 'Enter the next number as digits only, like 0001', { max: 10, blank: 'Enter the next invoice number' });
export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1d4ed8');
export const currencyCode = z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code, like INR'));

/** Free text: any characters, capped. */
export const textOptional = (max, label = 'Text') => z.preprocess(blankToEmpty, z.string('Enter text').trim().max(max, `${label} can be at most ${max} characters`)).optional();
export const textRequired = (max, label = 'This field') => z.preprocess(blankToEmpty, z.string(`${label} is required`).trim().min(1, `${label} is required`).max(max, `${label} can be at most ${max} characters`));

/** Password being SET: 8+ characters with a letter and a digit. (Sign-in only checks it is present.) */
export const newPassword = z.string('Enter a password').min(8, 'Password must be at least 8 characters').max(200, 'Password is too long').refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Password needs at least one letter and one number');
export const optionalNewPassword = z.preprocess(blankToEmpty, z.union([z.literal(''), newPassword])).optional();
export const loginPassword = z.string('Password is required').min(1, 'Password is required').max(200, 'Password is too long');

/* ───────────── numbers (blank string → treated as "not given") ───────────── */

const numberLike = (v) => (typeof v === 'string' ? (v.trim() === '' ? null : Number(v)) : v);

/** Required number in range. */
export const num = ({ min = 0, max = 1e9, int = false, label = 'Value' } = {}) => {
  let s = z.number(`${label} must be a number`).finite(`${label} must be a number`).min(min, `${label} must be at least ${min}`).max(max, `${label} must be at most ${max}`);
  if (int) s = s.int(`${label} must be a whole number`);
  return z.preprocess(numberLike, s);
};
/** May be blank (→ null); otherwise in range. */
export const numOptional = (opts) => z.preprocess((v) => (v === undefined ? undefined : numberLike(v)), num(opts).nullable().optional().or(z.null()));

export const lat = num({ min: -90, max: 90, label: 'Latitude' });
export const lng = num({ min: -180, max: 180, label: 'Longitude' });
export const objectIdString = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
export const objectIdOrBlank = z.preprocess(blankToEmpty, z.union([z.literal(''), objectIdString])).optional();

export { z };

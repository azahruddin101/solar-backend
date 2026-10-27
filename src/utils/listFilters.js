/** Shared list filters: text search helpers and inclusive `YYYY-MM-DD` date ranges (UTC day bounds). */

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseDateFromParam(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return null;
  return new Date(`${s}T00:00:00.000Z`);
}

export function parseDateToParam(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return null;
  return new Date(`${s}T23:59:59.999Z`);
}

/** `{ [field]: { $gte?, $lte? } }` or null when neither bound is set. */
export function dateRangeOnField(field, from, to) {
  const fromD = parseDateFromParam(from);
  const toD = parseDateToParam(to);
  if (!fromD && !toD) return null;
  const range = {};
  if (fromD) range.$gte = fromD;
  if (toD) range.$lte = toD;
  return { [field]: range };
}

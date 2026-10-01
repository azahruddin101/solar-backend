// Turns a `.lean()` query result into the same shape `doc.toJSON()` would give (see models/schemaOptions.js):
// `_id` -> `id` (string), no `__v`, no `passwordHash`, applied recursively into populated sub-documents.
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && typeof v.toHexString !== 'function';
}

function transform(value) {
  if (Array.isArray(value)) return value.map(transform);
  if (value && typeof value.toHexString === 'function') return value.toHexString(); // ObjectId
  if (!isPlainObject(value)) return value;
  const { _id, __v, passwordHash, ...rest } = value;
  const out = _id !== undefined ? { id: typeof _id === 'string' ? _id : String(_id) } : {};
  for (const key of Object.keys(rest)) out[key] = transform(rest[key]);
  return out;
}

/** Apply to a single lean document (or null). */
export const toApiJSON = (doc) => (doc ? transform(doc) : doc);

/** Apply to an array of lean documents. */
export const toApiJSONList = (docs) => (docs || []).map(transform);

/** Pagination query params, clamped to sane bounds. */
export function parsePagination(query = {}, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

import { HttpError } from '../utils/HttpError.js';

/** Validate (and normalise) req.body with a zod schema. On failure: 400 with the first message and per-field messages in `details.fields`. */
export const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body ?? {});
  if (result.success) {
    req.body = result.data;
    return next();
  }
  const fields = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!(key in fields)) fields[key] = issue.message;
  }
  throw new HttpError(400, Object.values(fields)[0], 'VALIDATION', { fields });
};

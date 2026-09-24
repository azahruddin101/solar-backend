import mongoose from 'mongoose';
import multer from 'multer';
import { HttpError } from '../utils/HttpError.js';

export const notFoundHandler = (req, res) => res.status(404).json({ error: 'Not found' });

/** Mongoose's own messages name the schema path ("Path `price` (-1) is less than…"); say it in plain words. */
function friendly(e) {
  const field = String(e.path || 'value').split('.').pop().replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const { kind, properties: p = {} } = e;
  if (!/^Path `|^Cast to|is not a valid enum/.test(e.message)) return e.message; // a message written in the schema
  if (kind === 'required') return `The ${field} is required`;
  if (kind === 'min') return `The ${field} must be at least ${p.min}`;
  if (kind === 'max') return `The ${field} must be at most ${p.max}`;
  if (kind === 'maxlength') return `The ${field} is too long (up to ${p.maxlength} characters)`;
  if (kind === 'enum') return `“${e.value}” is not a valid ${field}`;
  return `The ${field} is not valid`;
}

export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.details ? { details: err.details } : {}),
    });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large' : err.message });
  // every invalid field, one per line (the error dialog lists them)
  if (err instanceof mongoose.Error.ValidationError) return res.status(400).json({ error: [...new Set(Object.values(err.errors).map(friendly))].join('\n') || 'Invalid data' });
  if (err instanceof mongoose.Error.VersionError) return res.status(409).json({ error: 'This was just changed by someone else. Reload and try again.' });
  if (err instanceof mongoose.Error.CastError) return res.status(400).json({ error: `Invalid value for ${err.path}` });
  if (err.code === 11000) return res.status(409).json({ error: 'That value is already in use' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

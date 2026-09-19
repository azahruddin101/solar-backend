import mongoose from 'mongoose';
import multer from 'multer';
import { HttpError } from '../utils/HttpError.js';

export const notFoundHandler = (req, res) => res.status(404).json({ error: 'Not found' });

export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 2 MB or smaller' : err.message });
  if (err instanceof mongoose.Error.ValidationError) return res.status(400).json({ error: Object.values(err.errors)[0]?.message || 'Invalid data' });
  if (err instanceof mongoose.Error.CastError) return res.status(400).json({ error: `Invalid value for ${err.path}` });
  if (err.code === 11000) return res.status(409).json({ error: 'That value is already in use' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

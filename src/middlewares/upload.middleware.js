// Branding image uploads (logo, e-signature, QR code): multer writes them straight into the
// uploads folder as <companyId>-<kind>-<random>.<ext>.
import crypto from 'node:crypto';
import fs from 'node:fs';
import multer from 'multer';
import { env } from '../config/env.js';
import { ASSET_KINDS, IMAGE_TYPES } from '../constants/index.js';
import { badRequest } from '../utils/HttpError.js';

fs.mkdirSync(env.uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, env.uploadDir),
  filename: (req, file, cb) => cb(null, `${req.company.id}-${req.params.kind}-${crypto.randomBytes(6).toString('hex')}.${IMAGE_TYPES[file.mimetype]}`),
});

export const uploadImage = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ASSET_KINDS.includes(req.params.kind)) return cb(badRequest('Unknown asset'));
    if (!IMAGE_TYPES[file.mimetype]) return cb(badRequest('Upload a PNG, JPG or WebP image'));
    cb(null, true);
  },
}).single('file');

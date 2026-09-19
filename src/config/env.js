// Environment configuration (loaded from backend/.env by the npm scripts).
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

if (!process.env.JWT_SECRET) console.warn('JWT_SECRET is not set - using a random secret, so every restart signs everyone out.');

export const env = {
  port: Number(process.env.PORT) || 4000,
  // Comma-separated list of frontend origins allowed to call this API.
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/solar_saas',
  uploadDir: process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'),
  jwtSecret: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  jwtExpires: process.env.JWT_EXPIRES || '7d',
  superAdminEmail: (process.env.SUPERADMIN_EMAIL || 'admin@solarplanner.local').toLowerCase(),
  superAdminPassword: process.env.SUPERADMIN_PASSWORD || '',
  googleKey: process.env.GOOGLE_MAPS_API_KEY || '',
};

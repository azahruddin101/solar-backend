// Environment configuration — always loads backend/.env (overrides stale shell exports).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Parse backend/.env so IDE / node without --env-file still pick up the settings. */
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadDotEnv();

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set in production (a random per-start secret would sign everyone out on every restart and breaks multiple instances).');
if (!process.env.JWT_SECRET) console.warn('JWT_SECRET is not set - using a random secret, so every restart signs everyone out.');

/** A connection string safe to print: credentials and query options removed (mongodb+srv://cluster0.example.net/dbname). */
export function redactMongoUri(uri) {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unreadable MONGODB_URI)';
  }
}

export const env = {
  // 'development' | 'production' | '' — anything that is not exactly 'development' is treated as NOT development
  nodeEnv: process.env.NODE_ENV || '',
  port: Number(process.env.PORT) || 4000,
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/solar_saas',
  // Object storage for uploads. Set S3_BUCKET to use S3 (or any S3-compatible store via S3_ENDPOINT); otherwise files stay on local disk.
  s3: {
    bucket: (process.env.S3_BUCKET || '').trim(),
    region: (process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1').trim(),
    endpoint: (process.env.S3_ENDPOINT || '').trim(),
    prefix: (process.env.S3_PREFIX || 'uploads/').trim().replace(/^\/+/, ''),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  },
  // number of reverse proxies in front of the API (so req.ip is the real client); 0 = none
  trustProxy: Number(process.env.TRUST_PROXY) || 0,
  uploadDir: process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'),
  jwtSecret: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  jwtExpires: process.env.JWT_EXPIRES || '7d',
  superAdminEmail: (process.env.SUPERADMIN_EMAIL || 'admin@solarplanner.local').toLowerCase(),
  superAdminPassword: process.env.SUPERADMIN_PASSWORD || '',
  googleKey: process.env.GOOGLE_MAPS_API_KEY || '',
  frontendUrl: (process.env.FRONTEND_URL || 'http://localhost:3000').trim().replace(/\/+$/, ''),
  oneSignalAppId: (process.env.ONESIGNAL_APP_ID || '').trim(),
  oneSignalRestApiKey: (process.env.ONESIGNAL_REST_API_KEY || '').trim(),
};

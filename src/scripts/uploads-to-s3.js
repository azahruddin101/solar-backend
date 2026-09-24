// One-time: copy the files in the local uploads folder into the S3 bucket (S3_BUCKET must be set).
// Safe to re-run; files already in S3 are overwritten with the same content. Local files are left in place.
//   npm run uploads:s3            copy everything
//   npm run uploads:s3 -- --dry   only list what would be copied
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { putFile, usingS3 } from '../services/storage.service.js';

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };

if (!usingS3()) {
  console.error('S3_BUCKET is not set in backend/.env, nothing to do.');
  process.exit(1);
}
const dry = process.argv.includes('--dry');
let copied = 0;
for (const entry of await fs.readdir(env.uploadDir, { withFileTypes: true }).catch(() => [])) {
  if (!entry.isFile() || entry.name.startsWith('.')) continue; // sub-folders (e.g. reports/) are not part of the app's uploads
  console.log(`${dry ? 'would copy' : 'copying'} ${entry.name}`);
  if (!dry) await putFile(entry.name, await fs.readFile(path.join(env.uploadDir, entry.name)), TYPES[path.extname(entry.name).toLowerCase()] || 'application/octet-stream');
  copied++;
}
console.log(`${dry ? 'Would copy' : 'Copied'} ${copied} file${copied === 1 ? '' : 's'} to s3://${env.s3.bucket}/${env.s3.prefix}`);

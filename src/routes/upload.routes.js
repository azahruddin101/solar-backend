// GET /uploads/<name>: streams a stored file (S3 or local disk); the bucket itself stays private.
// Public files (branding, avatars) need nothing. Protected files (documents, installation photos, ticket attachments)
// need the short-lived ?exp=&sig= from GET /api/files/link.
import { Router } from 'express';
import path from 'node:path';
import { env } from '../config/env.js';
import { isProtected, SAFE_NAME, validSignature } from '../services/fileAccess.service.js';
import { openFile } from '../services/storage.service.js';

// Shown inline in the browser; anything else is forced to download so an uploaded HTML/SVG can never run on our origin.
const INLINE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };

const router = Router();

router.get('/:name', async (req, res) => {
  const { name } = req.params;
  if (!SAFE_NAME.test(name)) return res.status(404).end();
  const locked = isProtected(name);
  if (locked && !validSignature(name, req.query.exp, req.query.sig)) return res.status(403).json({ error: 'This link has expired or is not valid' });
  const file = await openFile(name);
  if (!file) return res.status(404).end();

  const ext = path.extname(name).toLowerCase();
  const inline = INLINE[ext];
  // A PDF may be shown inline in our own app (e.g. the design version preview modal), so it needs framing
  // allowed for our origins specifically — everything else keeps the blanket X-Frame-Options: DENY.
  const framable = ext === '.pdf';
  res.set({
    'Content-Type': inline || 'application/octet-stream',
    'Cache-Control': locked ? 'private, max-age=300' : 'public, max-age=604800',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    ...(framable ? { 'Content-Security-Policy': `frame-ancestors 'self' ${env.corsOrigins.join(' ')}` } : { 'X-Frame-Options': 'DENY' }),
    'Referrer-Policy': 'no-referrer',
    ...(process.env.NODE_ENV === 'production' && { 'Strict-Transport-Security': 'max-age=15552000; includeSubDomains' }),
    ...(!inline && { 'Content-Disposition': `attachment; filename="${name}"` }),
    ...(file.etag && { ETag: file.etag }),
    ...(file.lastModified && { 'Last-Modified': new Date(file.lastModified).toUTCString() }),
  });
  if (file.etag && req.get('if-none-match') === file.etag) {
    file.stream.destroy?.();
    return res.status(304).end();
  }
  if (file.contentLength != null) res.set('Content-Length', String(file.contentLength));
  file.stream.on('error', () => res.destroy());
  file.stream.pipe(res);
});

export default router;

// GET /uploads/<name>: streams a stored file (S3 or local disk); the bucket itself stays private.
// Public files (branding, avatars) need nothing. Protected files (documents, installation photos, ticket attachments)
// need the short-lived ?exp=&sig= from GET /api/files/link. Range requests are answered (206), so a PDF viewer can show
// the first pages of a large file before the rest arrives; ?download=<name> saves the file under that name instead.
import { Router } from 'express';
import path from 'node:path';
import { env } from '../config/env.js';
import { isProtected, SAFE_NAME, validSignature } from '../services/fileAccess.service.js';
import { openFile } from '../services/storage.service.js';

// Shown inline in the browser; anything else is forced to download so an uploaded HTML/SVG can never run on our origin.
const INLINE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };

/** `name` as a Content-Disposition attachment: a plain fallback plus the exact (UTF-8) name for browsers that read it. */
function attachment(name) {
  const clean = String(name).replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim().slice(0, 200) || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

const router = Router();

router.get('/:name', async (req, res) => {
  const { name } = req.params;
  if (!SAFE_NAME.test(name)) return res.status(404).end();
  const locked = isProtected(name);
  if (locked && !validSignature(name, req.query.exp, req.query.sig)) return res.status(403).json({ error: 'This link has expired or is not valid' });
  // Stored files never change (each upload gets a new random name), so If-Range needs no check.
  const file = await openFile(name, { range: req.get('range') });
  if (!file) return res.status(404).end();
  if (file.unsatisfiable) return res.status(416).set({ 'Content-Range': file.contentRange, 'Accept-Ranges': 'bytes' }).end();

  const ext = path.extname(name).toLowerCase();
  const inline = INLINE[ext];
  // A PDF may be shown inline in our own app (e.g. the design version preview modal), so it needs framing
  // allowed for our origins specifically — everything else keeps the blanket X-Frame-Options: DENY.
  const framable = ext === '.pdf';
  const download = typeof req.query.download === 'string' && req.query.download.trim();
  res.set({
    'Content-Type': inline || 'application/octet-stream',
    'Cache-Control': locked ? 'private, max-age=300' : 'public, max-age=604800',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    ...(framable ? { 'Content-Security-Policy': `frame-ancestors 'self' ${env.corsOrigins.join(' ')}` } : { 'X-Frame-Options': 'DENY' }),
    'Referrer-Policy': 'no-referrer',
    ...(process.env.NODE_ENV === 'production' && { 'Strict-Transport-Security': 'max-age=15552000; includeSubDomains' }),
    'Accept-Ranges': 'bytes',
    ...(download ? { 'Content-Disposition': attachment(download) } : !inline && { 'Content-Disposition': `attachment; filename="${name}"` }),
    ...(file.etag && { ETag: file.etag }),
    ...(file.lastModified && { 'Last-Modified': new Date(file.lastModified).toUTCString() }),
  });
  if (!file.partial && file.etag && req.get('if-none-match') === file.etag) {
    file.stream.destroy?.();
    return res.status(304).end();
  }
  if (file.contentLength != null) res.set('Content-Length', String(file.contentLength));
  if (file.partial) res.status(206).set('Content-Range', file.contentRange);
  file.stream.on('error', () => res.destroy());
  res.on('close', () => { if (!res.writableFinished) file.stream.destroy?.(); }); // viewer cancelled: stop reading from S3
  file.stream.pipe(res);
});

export default router;

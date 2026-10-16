import path from 'node:path';
import { env } from '../config/env.js';
import { openFile } from '../services/storage.service.js';

const INLINE = { '.pdf': 'application/pdf' };

/** Stream an uploaded file (local disk or S3) to an HTTP response. */
export async function streamUpload(name, req, res) {
  const file = await openFile(name);
  if (!file) return false;

  const ext = path.extname(name).toLowerCase();
  const inline = INLINE[ext] || 'application/octet-stream';
  res.set({
    'Content-Type': inline,
    'Cache-Control': 'private, max-age=300',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `frame-ancestors 'self' ${env.corsOrigins.join(' ')}`,
    'Referrer-Policy': 'no-referrer',
    ...(process.env.NODE_ENV === 'production' && { 'Strict-Transport-Security': 'max-age=15552000; includeSubDomains' }),
    'Content-Disposition': `inline; filename="${name}"`,
    ...(file.etag && { ETag: file.etag }),
    ...(file.lastModified && { 'Last-Modified': new Date(file.lastModified).toUTCString() }),
  });
  if (file.etag && req.get('if-none-match') === file.etag) {
    file.stream.destroy?.();
    res.status(304).end();
    return true;
  }
  if (file.contentLength != null) res.set('Content-Length', String(file.contentLength));
  file.stream.on('error', () => res.destroy());
  file.stream.pipe(res);
  return true;
}

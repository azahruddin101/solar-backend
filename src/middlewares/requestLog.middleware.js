// One access line per HTTP response, written when the response finishes so status and the signed-in user are known.
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

const SECRET_QUERY = new Set(['mt', 'token', 'password', 'secret', 'access_token', 'refresh_token', 'code', 'key', 'authorization', 'jwt']);

/** Path plus query, with credentials and short-lived tokens replaced so they never reach the PM2 log. */
export function safePath(req) {
  const raw = req.originalUrl || req.url || '/';
  const q = raw.indexOf('?');
  if (q === -1) return raw;
  const path = raw.slice(0, q);
  const params = new URLSearchParams(raw.slice(q + 1));
  const parts = [];
  for (const [key, value] of params) {
    parts.push(`${key}=${SECRET_QUERY.has(key.toLowerCase()) ? '[redacted]' : value}`);
  }
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

function userId(req) {
  if (!req.user) return '';
  if (req.user.id) return String(req.user.id);
  if (req.user._id) return String(req.user._id);
  return '';
}

function levelFor(method, pathOnly, status) {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  // Preflight and successful health checks are not API work; keep them out of the default PM2 log.
  if (method === 'OPTIONS') return 'debug';
  if (method === 'GET' && pathOnly === '/health') return 'debug';
  return 'info';
}

export function requestLogger(req, res, next) {
  const id = req.get('x-request-id') || randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  const start = process.hrtime.bigint();

  const fields = (status) => {
    const path = safePath(req);
    const pathOnly = path.split('?')[0];
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return {
      level: typeof status === 'number' ? levelFor(req.method, pathOnly, status) : 'warn',
      fields: {
        method: req.method,
        path,
        status,
        ms: ms.toFixed(1),
        ip: req.ip,
        user: userId(req),
        role: req.user?.role,
        rid: id,
      },
    };
  };

  res.on('finish', () => {
    const line = fields(res.statusCode);
    logger[line.level]('http', line.fields);
  });
  res.on('close', () => {
    if (res.writableFinished) return;
    const line = fields('aborted');
    logger.warn('http', line.fields);
  });
  next();
}

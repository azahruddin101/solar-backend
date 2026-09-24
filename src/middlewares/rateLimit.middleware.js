// Fixed-window request limiter. Keys are the signed-in user (or the client IP when nobody is signed in yet).
// In-memory: limits apply per server process (put a shared store such as Redis behind it if you run several).
import { HttpError } from '../utils/HttpError.js';

const buckets = new Map(); // `${name}|${key}` → { count, resetAt }

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60 * 1000);
sweep.unref(); // never keeps the process alive

/** `by: 'user'` keys on the authenticated user (falls back to IP); `by: 'ip'` always keys on the IP. */
export function rateLimit({ name, windowMs, max, by = 'user' }) {
  return (req, res, next) => {
    const key = by === 'user' && req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
    const id = `${name}|${key}`;
    const now = Date.now();
    let b = buckets.get(id);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(id, b);
    }
    b.count += 1;
    res.set({ 'RateLimit-Limit': String(max), 'RateLimit-Remaining': String(Math.max(0, max - b.count)) });
    if (b.count > max) {
      const wait = Math.ceil((b.resetAt - now) / 1000);
      res.set('Retry-After', String(wait));
      return next(new HttpError(429, `Too many requests. Try again in ${wait} seconds.`, 'RATE_LIMITED'));
    }
    next();
  };
}

/** For tests. */
export const resetRateLimits = () => buckets.clear();

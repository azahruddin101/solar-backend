// Response headers for the API's JSON responses. (/uploads streams files and sets its own headers.)
const HSTS = 'max-age=15552000; includeSubDomains'; // 180 days; only meaningful over HTTPS

export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", // an API never needs to run or embed anything
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    ...(process.env.NODE_ENV === 'production' ? { 'Strict-Transport-Security': HSTS } : {}),
  });
  next();
}

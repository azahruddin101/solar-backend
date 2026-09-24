// Express application: middleware, static uploads, API routes, error handling.
import cors from 'cors';
import express from 'express';
import { dbReady } from './config/db.js';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware.js';
import { rateLimit } from './middlewares/rateLimit.middleware.js';
import { securityHeaders } from './middlewares/securityHeaders.middleware.js';
import apiRoutes from './routes/index.js';
import uploadRoutes from './routes/upload.routes.js';

const app = express();
app.disable('x-powered-by');
if (env.trustProxy) app.set('trust proxy', env.trustProxy);
// Listed origins always; only in development also any private-network address (phone on the same Wi-Fi → http://192.168.x.x:3000).
const LAN_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)(:\d+)?$/;
app.use(cors({
  origin: (origin, done) => done(null, !origin || env.corsOrigins.includes(origin) || (env.nodeEnv === 'development' && LAN_ORIGIN.test(origin))),
}));
// behind a reverse proxy every request would look like it comes from the proxy, and the per-address limits would
// then apply to all users together: say so once instead of failing silently
let warnedProxy = false;
app.use((req, res, next) => {
  if (!warnedProxy && !env.trustProxy && req.get('x-forwarded-for')) {
    warnedProxy = true;
    console.warn('Requests carry X-Forwarded-For but TRUST_PROXY is not set: rate limits will treat every user as one address. Set TRUST_PROXY to the number of proxies in front of the API.');
  }
  next();
});
// the API-wide limit runs before request bodies are parsed, so a flood is refused cheaply
app.use('/api', rateLimit({ name: 'api', windowMs: 5 * 60 * 1000, max: 1500, by: 'ip' }));
app.use(express.json({ limit: '4mb' }));

app.get('/health', securityHeaders, (req, res) => res.json({ ok: true, db: dbReady() }));
// Company logos / signatures / QR images (random file names; loaded by <img> and the PDF generator).
app.use('/uploads', uploadRoutes);
// tighter limits sit on the expensive routes (see routes/index.js)
app.use('/api', securityHeaders, apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;

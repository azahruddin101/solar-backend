// Express application: middleware, static uploads, API routes, error handling.
import cors from 'cors';
import express from 'express';
import { dbReady } from './config/db.js';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware.js';
import apiRoutes from './routes/index.js';

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: env.corsOrigins }));
app.use(express.json({ limit: '4mb' }));

app.get('/health', (req, res) => res.json({ ok: true, db: dbReady() }));
// Company logos / signatures / QR images (random file names; loaded by <img> and the PDF generator).
app.use('/uploads', express.static(env.uploadDir, { maxAge: '7d', index: false, dotfiles: 'deny', setHeaders: (res) => res.set('Cross-Origin-Resource-Policy', 'cross-origin') }));
app.use('/api', apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;

// Entry point: connect to MongoDB, run data migrations, seed the super admin, start the HTTP server.
import app from './app.js';
import { connectDb } from './config/db.js';
import { env, redactMongoUri } from './config/env.js';
import { migrateCatalog } from './migrations/catalog.migration.js';
import { enforceTenantCatalogIsolation } from './migrations/tenantCatalog.migration.js';
import { ensureSessionTtlIndex } from './migrations/authSessionTtl.migration.js';
import { capUnlimitedLimits } from './migrations/limits.migration.js';
import { migratePlanRequests } from './migrations/planRequest.migration.js';
import { capitalizeClientNames, capitalizeProductNames, capitalizeProductUnits } from './migrations/unitCase.migration.js';
import { AuthSession } from './models/index.js';
import { ensureDefaultPlans } from './seeders/plans.seeder.js';
import { ensureSuperAdmin } from './seeders/superAdmin.seeder.js';

try {
  const db = await connectDb();
  console.log(`MongoDB connected: ${db.name}`);
} catch (e) {
  console.error(`Could not connect to MongoDB at ${redactMongoUri(env.mongoUri)}: ${String(e.message).replaceAll(env.mongoUri, '(connection string)')}`);
  process.exit(1);
}
if (!env.nodeEnv) console.warn('NODE_ENV is not set. Set NODE_ENV=production in deployment (security headers, CORS and seed protection depend on it).');
await migrateCatalog();
await enforceTenantCatalogIsolation();
await capitalizeProductUnits();
await capitalizeProductNames();
await capitalizeClientNames();
await migratePlanRequests();
await capUnlimitedLimits();
await ensureSessionTtlIndex();
await ensureDefaultPlans();
await AuthSession.deleteMany({ $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }] });
await ensureSuperAdmin();
app.listen(env.port, () => console.log(`API listening on http://localhost:${env.port} (allowed origins: ${env.corsOrigins.join(', ')})`));

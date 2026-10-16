// Entry point: connect to MongoDB, run data migrations, seed the super admin, start the HTTP server.
import app from './app.js';
import { connectDb } from './config/db.js';
import { env, redactMongoUri } from './config/env.js';
import { migrateCatalog } from './migrations/catalog.migration.js';
import { enforceTenantCatalogIsolation } from './migrations/tenantCatalog.migration.js';
import { ensureSessionTtlIndex } from './migrations/authSessionTtl.migration.js';
import { capUnlimitedLimits } from './migrations/limits.migration.js';
import { fixShareTokenIndex } from './migrations/shareToken.migration.js';
import { migrateParentCategories } from './migrations/parentCategory.migration.js';
import { migratePlanRequests } from './migrations/planRequest.migration.js';
import { capitalizeClientNames, capitalizeProductNames, capitalizeProductUnits } from './migrations/unitCase.migration.js';
import { backfillLeadAssignmentCompany, ensureUniqueMetaPage } from './migrations/leadTenant.migration.js';
import { migrateStaffPermissions } from './migrations/staffPermissions.migration.js';
import { AuthSession } from './models/index.js';
import { ensureDefaultPlans } from './seeders/plans.seeder.js';
import { ensureSuperAdmin } from './seeders/superAdmin.seeder.js';
import { logger } from './utils/logger.js';
import { startLeadIntegrationWorkers } from './integrations/leads.js';

process.on('unhandledRejection', (err) => {
  logger.error('unhandledRejection', { err: err?.message || String(err) });
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { err: err?.message || String(err) });
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});

try {
  const db = await connectDb();
  logger.info('MongoDB connected', { db: db.name });
} catch (e) {
  logger.error('Could not connect to MongoDB', {
    uri: redactMongoUri(env.mongoUri),
    err: String(e.message).replaceAll(env.mongoUri, '(connection string)'),
  });
  process.exit(1);
}
if (!env.nodeEnv) logger.warn('NODE_ENV is not set. Set NODE_ENV=production in deployment (security headers, CORS and seed protection depend on it).');
await migrateCatalog();
await enforceTenantCatalogIsolation();
await capitalizeProductUnits();
await capitalizeProductNames();
await capitalizeClientNames();
await migrateParentCategories();
await migratePlanRequests();
await fixShareTokenIndex();
await capUnlimitedLimits();
await ensureSessionTtlIndex();
await migrateStaffPermissions();
await backfillLeadAssignmentCompany();
await ensureUniqueMetaPage();
await ensureDefaultPlans();
await AuthSession.deleteMany({ $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }] });
await ensureSuperAdmin();
startLeadIntegrationWorkers();
app.listen(env.port, () => logger.info('API listening', { url: `http://localhost:${env.port}`, origins: env.corsOrigins.join(',') }));

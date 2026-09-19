// Entry point: connect to MongoDB, seed the super admin, start the HTTP server.
import app from './app.js';
import { connectDb } from './config/db.js';
import { env } from './config/env.js';
import { ensureSuperAdmin } from './seeders/superAdmin.seeder.js';

try {
  const db = await connectDb();
  console.log(`MongoDB connected: ${db.name}`);
} catch (e) {
  console.error(`Could not connect to MongoDB at ${env.mongoUri}: ${e.message}`);
  process.exit(1);
}
await ensureSuperAdmin();
app.listen(env.port, () => console.log(`API listening on http://localhost:${env.port} (allowed origins: ${env.corsOrigins.join(', ')})`));

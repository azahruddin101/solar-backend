import { AuthSession } from '../models/index.js';

// The expiresAt index used to be a plain one; a TTL index on the same key needs the old one dropped first.
export async function ensureSessionTtlIndex() {
  const c = AuthSession.collection;
  try {
    const existing = (await c.indexes()).find((i) => i.name === 'expiresAt_1');
    if (existing && existing.expireAfterSeconds === undefined) await c.dropIndex('expiresAt_1');
    await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expiresAt_1' });
  } catch (e) {
    console.warn(`Could not set up session expiry cleanup: ${e.message}`);
  }
}

// Demo seeds create accounts with a known password, so they must never run against a production database by accident.
import '../config/env.js'; // loads backend/.env first

/** The password given to demo accounts: DEMO_PASSWORD from the environment, or a fixed default for local development. */
export const demoPassword = () => process.env.DEMO_PASSWORD || 'Demo@12345';

/** Throws in production unless the seed was explicitly allowed and a real DEMO_PASSWORD was provided. */
export function assertSeedAllowed() {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.ALLOW_DEMO_SEED !== 'true') throw new Error('Refusing to create demo accounts when NODE_ENV=production. Set ALLOW_DEMO_SEED=true if this is really intended.');
  const pw = process.env.DEMO_PASSWORD || '';
  if (pw.length < 12) throw new Error('Set DEMO_PASSWORD (at least 12 characters) to seed demo accounts in production; the built-in demo password is for local development only.');
}

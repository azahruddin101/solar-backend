// Password hashing with scrypt (node:crypto).
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(plain, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(plain, stored) {
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = await scrypt(plain, Buffer.from(salt, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

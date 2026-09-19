import mongoose from 'mongoose';
import { badRequest, notFound } from './HttpError.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function objectId(value, what = 'Record') {
  if (!mongoose.isValidObjectId(value)) throw notFound(what);
  return value;
}

export function email(value, { required = true } = {}) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v && !required) return '';
  if (!EMAIL.test(v) || v.length > 200) throw badRequest('Enter a valid email address');
  return v;
}

export function password(value) {
  const v = String(value ?? '');
  if (v.length < 8 || v.length > 200) throw badRequest('Password must be at least 8 characters');
  return v;
}

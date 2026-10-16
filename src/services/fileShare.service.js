import crypto from 'node:crypto';
import path from 'node:path';
import { FileShare } from '../models/fileShare.model.js';
import { notFound } from '../utils/HttpError.js';
import { SHARE_LINK_TTL_MS, assertCanOpen, SAFE_NAME } from './fileAccess.service.js';

const TOKEN = /^[A-Za-z0-9_-]{8,32}$/;

async function createShare(companyId, pdfName) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const token = crypto.randomBytes(9).toString('base64url');
    try {
      return await FileShare.create({
        token,
        pdfName,
        company: companyId,
        expiresAt: new Date(Date.now() + SHARE_LINK_TTL_MS),
      });
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  throw new Error('Could not create a share link');
}

/** Short URL for WhatsApp / SMS: `/api/public/documents/<token>` (no long query string). */
export async function shareUrlFor(user, url) {
  const name = path.basename(String(url ?? ''));
  if (String(url ?? '') !== `/uploads/${name}` || !SAFE_NAME.test(name)) throw notFound('File');
  await assertCanOpen(user, name);

  const now = Date.now();
  let row = await FileShare.findOne({ pdfName: name, company: user.company, expiresAt: { $gt: new Date(now) } });
  if (!row) row = await createShare(user.company, name);
  else {
    row.expiresAt = new Date(now + SHARE_LINK_TTL_MS);
    await row.save();
  }
  return { url: `/api/public/documents/${row.token}`, expiresAt: row.expiresAt.toISOString() };
}

export async function pdfNameForToken(token) {
  if (!TOKEN.test(String(token || ''))) throw notFound('Document');
  const row = await FileShare.findOne({ token, expiresAt: { $gt: new Date() } });
  if (!row) throw notFound('Document');
  return row.pdfName;
}

export async function revokeSharesForPdf(pdfName) {
  if (!pdfName) return;
  await FileShare.deleteMany({ pdfName });
}

import { linkFor } from '../services/fileAccess.service.js';
import { shareUrlFor } from '../services/fileShare.service.js';

export async function link(req, res) {
  res.set('Cache-Control', 'no-store').json(await linkFor(req.user, req.query.url));
}

/** Short public URL for billing PDFs shared with clients (WhatsApp, etc.). */
export async function shareLink(req, res) {
  res.set('Cache-Control', 'no-store').json(await shareUrlFor(req.user, req.query.url));
}

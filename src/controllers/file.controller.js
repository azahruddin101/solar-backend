import { linkFor } from '../services/fileAccess.service.js';

export async function link(req, res) {
  res.set('Cache-Control', 'no-store').json(await linkFor(req.user, req.query.url));
}

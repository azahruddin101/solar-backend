import * as googleService from '../services/google.service.js';

export async function solar(req, res) {
  const body = await googleService.buildingInsights({ lat: req.query.lat, lng: req.query.lng, referer: req.get('referer') });
  res.set('Cache-Control', 'private, max-age=3600').json(body);
}

export async function staticMap(req, res) {
  const { type, buffer } = await googleService.staticMap({ query: req.query, referer: req.get('referer') });
  res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' }).send(buffer);
}

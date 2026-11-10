import * as googleService from '../services/google.service.js';
import { solarModel } from '../services/solarModel.service.js';
import { detectInOutline, detectRoof } from '../services/roofDetect.service.js';
import { signMapToken } from '../utils/token.js';

export async function solar(req, res) {
  const body = await googleService.buildingInsights({ lat: req.query.lat, lng: req.query.lng, referer: req.get('referer') });
  res.set('Cache-Control', 'private, max-age=3600').json(body);
}

export async function staticMap(req, res) {
  const { type, buffer } = await googleService.staticMap({ query: req.query, referer: req.get('referer') });
  res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' }).send(buffer);
}

export function mapToken(req, res) {
  res.set('Cache-Control', 'no-store').json({ token: signMapToken({ user: req.user, sid: req.sessionId, by: req.impersonatedBy }), expiresInSeconds: 15 * 60 });
}

/** Satellite picture → roof parts (outline, style, upper floors, verandahs) for the designer to build. */
export async function roofDetect(req, res) {
  // a drawn outline is the roof: only what is inside it is read; a pin alone finds the building
  const result = req.body?.outline
    ? await detectInOutline({ outline: req.body.outline, referer: req.get('referer') })
    : await detectRoof({ lat: req.body?.lat, lng: req.body?.lng, referer: req.get('referer') });
  res.set('Cache-Control', 'no-store').json(result);
}

/** The house as Google measured it: roof planes from Google's panel layout + height map and photo for 3D. */
export async function solarHouseModel(req, res) {
  const model = await solarModel({ lat: req.query.lat, lng: req.query.lng, outline: req.query.outline, referer: req.get('referer') });
  res.set('Cache-Control', 'private, no-cache').json(model); // the server keeps it; the browser always asks (models get improved)
}

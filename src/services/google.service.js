// Server-side calls to Google (Solar API, Maps Static API) so the key never reaches the browser.
import { env } from '../config/env.js';
import { HttpError, badRequest } from '../utils/HttpError.js';

const SOLAR_ENDPOINT = 'https://solar.googleapis.com/v1/buildingInsights:findClosest';
const STATIC_MAP_ENDPOINT = 'https://maps.googleapis.com/maps/api/staticmap';

const num = (v) => Number.parseFloat(v);
const refererHeader = (referer) => (referer ? { Referer: referer } : {});

function requireKey() {
  if (!env.googleKey) throw new HttpError(500, 'The server has no Google API key configured (GOOGLE_MAPS_API_KEY).', 'NO_KEY');
  return env.googleKey;
}

/** buildingInsights:findClosest — prefer the best imagery, fall back where HIGH isn't available. */
export async function buildingInsights({ lat, lng, referer }) {
  lat = num(lat);
  lng = num(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw badRequest('Valid lat and lng query parameters are required.');
  const key = requireKey();

  let last = null;
  for (const quality of ['HIGH', 'MEDIUM', 'LOW']) {
    const params = new URLSearchParams({ 'location.latitude': lat.toFixed(7), 'location.longitude': lng.toFixed(7), requiredQuality: quality, key });
    let upstream;
    try {
      upstream = await fetch(`${SOLAR_ENDPOINT}?${params}`, { headers: refererHeader(referer) });
    } catch {
      throw new HttpError(502, 'Could not reach the Google Solar API.', 'NETWORK');
    }
    const body = await upstream.json().catch(() => ({}));
    if (upstream.ok) return body;
    last = { status: upstream.status, message: body?.error?.message || upstream.statusText, code: body?.error?.status || 'ERROR' };
    if (upstream.status !== 404) break;
  }
  const message =
    last.status === 404
      ? 'Google Solar API has no data for this building yet.'
      : last.status === 403
        ? `Solar API request was denied: ${last.message}`
        : last.message;
  throw new HttpError(last.status, message, last.code);
}

/** Satellite image (3D ground texture, PDF site image). Optional outline: pts=lat,lng;lat,lng;… */
export async function staticMap({ query, referer }) {
  const lat = num(query.lat);
  const lng = num(query.lng);
  const zoom = Math.round(num(query.zoom ?? '20'));
  const width = Math.min(640, Math.max(64, Math.round(num(query.w ?? '640'))));
  const height = Math.min(640, Math.max(64, Math.round(num(query.h ?? '640'))));
  const maptype = ['satellite', 'hybrid', 'roadmap'].includes(query.maptype) ? query.maptype : 'satellite';
  if (![lat, lng, zoom, width, height].every(Number.isFinite) || zoom < 1 || zoom > 21) throw badRequest('Invalid parameters.');
  const key = requireKey();

  const params = new URLSearchParams({ center: `${lat},${lng}`, zoom: String(zoom), size: `${width}x${height}`, scale: '2', maptype, key });
  const pts = String(query.pts || '')
    .split(';')
    .map((s) => s.split(',').map(num))
    .filter((p) => p.length === 2 && p.every(Number.isFinite))
    .slice(0, 80);
  if (pts.length >= 3) {
    const path = [...pts, pts[0]].map(([a, b]) => `${a.toFixed(7)},${b.toFixed(7)}`).join('|');
    params.append('path', `color:0xf59e0bff|weight:4|fillcolor:0xf59e0b30|${path}`);
  }

  let upstream;
  try {
    upstream = await fetch(`${STATIC_MAP_ENDPOINT}?${params}`, { headers: refererHeader(referer) });
  } catch {
    throw new HttpError(502, 'Could not reach Google Static Maps.');
  }
  const type = upstream.headers.get('content-type') || '';
  if (!upstream.ok || !type.startsWith('image/')) {
    const text = await upstream.text().catch(() => '');
    throw new HttpError(upstream.ok ? 502 : upstream.status, text.slice(0, 300) || `Static Maps error ${upstream.status}`);
  }
  return { type, buffer: Buffer.from(await upstream.arrayBuffer()) };
}

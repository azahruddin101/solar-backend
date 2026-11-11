// Automatic roof detection: satellite picture → roof parts the designer can build in 3D.
//
// 1. Outline: the building's edge from Google Solar's roof mask (a GeoTIFF), else OpenStreetMap.
// 2. Claude looks at the satellite picture (with that outline drawn on it) and says what the roof is:
//    the main roof's outline, roof style (flat / slopes / four slopes / Kerala), steepness, the ends,
//    upper-floor roofs and lower verandah roofs, and how many storeys.
// 3. Every part is tidied (square corners, parts snapped together) and returned as lat/lng outlines
//    with the designer's own roof settings. Nothing is saved here: the designer applies it.
//
// Claude needs ANTHROPIC_API_KEY. Without it, the outline alone is returned as a plain roof.

import { boundedCache } from '../utils/boundedCache.js';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import mongoose from 'mongoose';
import { fromArrayBuffer } from 'geotiff';
import { env } from '../config/env.js';
import { HttpError, badRequest } from '../utils/HttpError.js';
import {
  centroid,
  cleanRing,
  squareSubtract,
  dominantAngle,
  ensureCCW,
  latLngToUtm,
  measureRoof,
  pointInPolygon,
  signedArea,
  simplifyRing,
  snapCorners,
  squareUp,
  staticMapFrame,
  toLatLng,
  toLocal,
  traceMaskOutline,
  utmToLatLng,
  utmZoneOf,
} from '../utils/roofOutline.js';
import { staticMap } from './google.service.js';

const DATA_LAYERS = 'https://solar.googleapis.com/v1/dataLayers:get';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const IMAGE_SIZE = 640; // CSS pixels; the picture is fetched at scale 2 → 1280 × 1280
const IMAGE_SCALE = 2;
const DEG = Math.PI / 180;

// ---------- 1. outline sources ----------

/** Building outline from Google Solar's roof mask, as lat/lng points, or null. */
export async function googleMaskOutline({ lat, lng, referer, userPoly = null, radius = 30 }) {
  if (!env.googleKey) return null;
  let layers = null;
  for (const quality of ['HIGH', 'MEDIUM', 'LOW', 'BASE']) {
    const params = new URLSearchParams({ 'location.latitude': lat.toFixed(7), 'location.longitude': lng.toFixed(7), radiusMeters: String(Math.min(100, Math.ceil(radius))), view: 'IMAGERY_LAYERS', requiredQuality: quality, pixelSizeMeters: '0.1', key: env.googleKey });
    if (quality === 'BASE') params.set('experiments', 'EXPANDED_COVERAGE');
    const res = await fetch(`${DATA_LAYERS}?${params}`, { headers: referer ? { Referer: referer } : {} }).catch(() => null);
    if (!res) return null;
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.maskUrl) {
      layers = body;
      break;
    }
    if (res.status !== 404 && res.status !== 400) {
      console.error(`[roof-detect] dataLayers ${res.status}: ${body?.error?.message || ''}`);
      return null;
    }
  }
  if (!layers) return null;
  const url = new URL(layers.maskUrl);
  url.searchParams.set('key', env.googleKey);
  const tif = await fetch(url, { headers: referer ? { Referer: referer } : {} }).catch(() => null);
  if (!tif?.ok) return null;
  const tiff = await fromArrayBuffer(await tif.arrayBuffer());
  const image = await tiff.getImage();
  const keys = image.getGeoKeys() || {};
  const zone = utmZoneOf(keys.ProjectedCSTypeGeoKey);
  if (!zone) return null;
  const [ox, oy] = image.getOrigin();
  const res = image.getResolution();
  const rx = Math.abs(res[0]);
  const ry = -Math.abs(res[1]); // rows run south from the top-left origin, whatever sign the file reports
  const width = image.getWidth();
  const height = image.getHeight();
  const [band] = await image.readRasters();
  const c = latLngToUtm({ lat, lng }, zone);
  let ring;
  if (userPoly) {
    // the user's own outline decides which pixels are this roof
    const px = userPoly.map((p) => {
      const u = latLngToUtm(p, zone);
      return { x: (u.x - ox) / rx, y: (u.y - oy) / ry };
    });
    const comp = new Uint8Array(width * height);
    const xs = px.map((p) => p.x);
    const ys = px.map((p) => p.y);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(height, Math.ceil(Math.max(...ys))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(width, Math.ceil(Math.max(...xs))); x++) {
        if (pointInPolygon({ x: x + 0.5, y: y + 0.5 }, px)) comp[y * width + x] = 1;
      }
    }
    ring = Object.assign(px, { component: comp });
  } else {
    ring = traceMaskOutline(band, width, height, (c.x - ox) / rx, (c.y - oy) / ry, Math.round(6 / Math.abs(rx)));
  }
  if (!ring) return null;
  // the height map on the same grid measures the roof: flat or sloped, its pitch, the wall height
  let measured = null;
  if (layers.dsmUrl) {
    try {
      const du = new URL(layers.dsmUrl);
      du.searchParams.set('key', env.googleKey);
      const dr = await fetch(du, { headers: referer ? { Referer: referer } : {} });
      if (dr.ok) {
        const dimg = await (await fromArrayBuffer(await dr.arrayBuffer())).getImage();
        if (dimg.getWidth() === width && dimg.getHeight() === height) {
          const [dsm] = await dimg.readRasters();
          measured = measureRoof(dsm, band, ring.component, width, height, rx);
        }
      }
    } catch (err) {
      console.error('[roof-detect] height map failed:', err.message);
    }
  }
  return { points: ring.map((p) => utmToLatLng({ x: ox + p.x * rx, y: oy + p.y * ry }, zone)), quality: layers.imageryQuality || null, date: layers.imageryDate || null, measured };
}

/** Building outline from OpenStreetMap (the building under the point, else the nearest one), or null. */
async function osmOutline({ lat, lng }) {
  const query = `[out:json][timeout:10];way["building"](around:40,${lat.toFixed(7)},${lng.toFixed(7)});out geom;`;
  const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'User-Agent': 'solar-designer-roof-detect/1.0' }, signal: AbortSignal.timeout(12000) }).catch(() => null);
  if (!res?.ok) return null;
  const body = await res.json().catch(() => null);
  const ref = { lat, lng };
  const ways = (body?.elements || []).filter((e) => e.type === 'way' && e.geometry?.length >= 4).map((e) => {
    const pts = e.geometry.map((g) => ({ lat: g.lat, lng: g.lon }));
    if (pts.length > 3 && Math.abs(pts[0].lat - pts.at(-1).lat) < 1e-9 && Math.abs(pts[0].lng - pts.at(-1).lng) < 1e-9) pts.pop();
    const local = pts.map((p) => toLocal(p, ref));
    const c = centroid(local);
    return { pts, inside: pointInPolygon({ x: 0, y: 0 }, local), dist: Math.hypot(c.x, c.y) };
  });
  const hit = ways.find((w) => w.inside) || ways.filter((w) => w.dist < 15).sort((a, b) => a.dist - b.dist)[0];
  return hit ? { points: hit.pts } : null;
}

/** Outline in local metres: simplified and squared. */
function tidy(points, ref, { simplify = 0.45, angle } = {}) {
  let local = ensureCCW(points.map((p) => toLocal(p, ref)));
  if (local.length > 8) local = simplifyRing(local, simplify);
  local = cleanRing(local);
  if (local.length < 3) return null;
  return ensureCCW(squareUp(local, 18, angle ?? dominantAngle(local)));
}

// ---------- 2. Claude reads the picture ----------

const ROOF_STYLES = ['flat', 'single_slope', 'two_slopes', 'four_slopes', 'kerala'];
const point = { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'], additionalProperties: false };
const DETECTION_SCHEMA = {
  type: 'object',
  properties: {
    houseFound: { type: 'boolean', description: 'A house roof is at or right next to the centre of the picture.' },
    outlineMatchesMainRoof: { type: 'boolean', description: 'The drawn amber outline follows the main roof well (within about half a metre). False when there is no amber outline.' },
    storeys: { type: 'integer', description: 'Storeys under the main roof (1 to 5), judged from shadows, size and surroundings.' },
    parts: {
      type: 'array',
      description: 'The roofs of this one house. Exactly one part has role "main".',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['main', 'upper', 'verandah'] },
          corners: { type: 'array', items: point, description: 'Corners of this roof at its outer edge (eaves), in image pixels, in order around the roof.' },
          roofStyle: { type: 'string', enum: ROOF_STYLES },
          steepness: { type: 'string', enum: ['gentle', 'normal', 'steep'] },
          ends: { type: 'string', enum: ['sloped', 'triangle', 'kerala_gablet'], description: 'For four_slopes / kerala roofs: what the short ends look like.' },
          slopeDownTowards: { type: 'string', enum: ['none', 'north', 'north_east', 'east', 'south_east', 'south', 'south_west', 'west', 'north_west'], description: 'For a single_slope roof: the direction its low edge faces. Otherwise none.' },
          overhang: { type: 'string', enum: ['none', 'small', 'wide'], description: 'How far the roof sticks out past the walls.' },
        },
        required: ['role', 'corners', 'roofStyle', 'steepness', 'ends', 'slopeDownTowards', 'overhang'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string', description: 'One or two short, plain sentences for a non-technical salesperson: what was found and anything uncertain (trees covering the roof, blurry picture).' },
  },
  required: ['houseFound', 'outlineMatchesMainRoof', 'storeys', 'parts', 'confidence', 'notes'],
  additionalProperties: false,
};

const SYSTEM = `You read rooftops from satellite pictures for a rooftop-solar design tool. Most customers are in India (many in Kerala), but the house can be anywhere: judge only from what the picture shows.
The picture is north-up. Your answer is turned straight into a 3D model of the house, so trace what is really there.

Roles of roof parts:
- main: the house's main roof. One polygon for the whole main roof, even when the house is L, T or U shaped.
- upper: a higher roof sitting on top of the main roof (an upper floor or a raised room). Its corners lie inside the main roof.
- verandah: a clearly lower roof joined to the house — sit-out, porch, car porch, work-area lean-to, a flat lower room. Trace the main roof without it.
Leave out neighbouring houses, sheds that stand apart, trees, and water tanks.

Roof styles:
- flat: concrete (RCC) terrace, often with a low wall around it, water tanks and stairs on it.
- single_slope: one sloping plane (sheet or tile).
- two_slopes: two planes meeting at one ridge, triangular wall at both ends.
- four_slopes: hip roof: slopes on all sides.
- kerala: only for a Kerala-style house: steep Mangalore-tile hip roof, usually with a small triangular gable (mukhappu) at the top of its ends, and wide eaves. Other tiled or shingled hip roofs are four_slopes.
Steepness: gentle under about 18°, normal 18–30°, steep over 30° (typical Kerala tile roofs are steep).

Corners: put them on the roof's outer edge (the eave line seen from above), in image pixels, x to the right and y down.
Use as few corners as the shape needs: 4 for a rectangle, 6 for an L. Keep walls straight and corners square when the roof looks square.`;

let anthropic = null;
const client = () => (anthropic ||= new Anthropic({ apiKey: env.anthropic.apiKey }));

async function askClaude({ image, frame, outlinePx, facts, extra = null, userDrawn = false }) {
  const text = [
    ...facts,
    `The picture is ${frame.width} × ${frame.height} pixels. The customer's house is at the centre, pixel (${frame.width / 2}, ${frame.height / 2}).`,
    outlinePx && userDrawn
      ? `The user drew the amber outline around exactly the roof they want designed. Its corners in pixels: ${outlinePx.map((p) => `(${Math.round(p.x)}, ${Math.round(p.y)})`).join(' ')}. Treat it as correct and look only inside it: everything outside the amber line is out of scope.`
      : outlinePx
      ? `An automatic building outline is drawn in amber. Its corners in pixels: ${outlinePx.map((p) => `(${Math.round(p.x)}, ${Math.round(p.y)})`).join(' ')}. It comes from other map data and is often shifted by a metre or two, cut by trees, or joined to a verandah: trust the picture, not the amber line.`
      : 'There is no automatic outline: trace the roof yourself.',
    extra || 'Describe the roof of the house at the centre.',
  ].join('\n');
  let response;
  try {
    response = await client().beta.messages.create({
      model: env.anthropic.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema: DETECTION_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: image.type, data: image.buffer.toString('base64') } }, { type: 'text', text }] }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'The AI service key is not valid. Contact the platform administrator.', 'AI_KEY');
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The AI service is busy. Try again in a minute.', 'AI_BUSY');
    if (err instanceof Anthropic.APIError) {
      console.error(`[roof-detect] Claude ${err.status}: ${err.message}`);
      throw new HttpError(502, 'The AI roof reader is not available right now. Try again in a moment.', 'AI_UPSTREAM');
    }
    throw err;
  }
  if (response.stop_reason === 'refusal') throw new HttpError(502, 'The AI could not read this picture.', 'AI_REFUSED');
  if (response.stop_reason === 'max_tokens') throw new HttpError(502, 'The AI answer was cut short. Try again.', 'AI_TRUNCATED');
  const out = response.content.find((b) => b.type === 'text');
  try {
    return JSON.parse(out?.text || '');
  } catch {
    throw new HttpError(502, 'The AI answer could not be read. Try again.', 'AI_PARSE');
  }
}

/** What is known for sure, told to Claude before it looks. */
function factsFor(measured, inKerala) {
  return [
    inKerala ? 'This house is in Kerala.' : 'This house is not in Kerala, so its roof is not Kerala style.',
    measured && `3D height survey of this building: ${Math.round((1 - measured.flatShare) * 100)}% of the roof is sloped${measured.pitch ? `, typical slope about ${Math.round(measured.pitch)}°` : ''}${measured.eaveHeight != null ? `, lowest roof edge about ${measured.eaveHeight.toFixed(1)} m above the ground` : ''}. Trust these measurements over the picture for flat-or-sloped and steepness.`,
  ].filter(Boolean);
}

/** Measured facts win over the picture reading, so the same house always gets the same kind of roof. */
function applyFacts(read, measured, inKerala) {
  for (const part of read.parts || []) {
    if (part.roofStyle === 'kerala' && !inKerala) part.roofStyle = 'four_slopes';
  }
  const mainRead = read.parts?.find((p) => p.role === 'main');
  if (mainRead && measured) {
    if (measured.flatShare > 0.7) mainRead.roofStyle = 'flat';
    else if (measured.flatShare < 0.4 && mainRead.roofStyle === 'flat') mainRead.roofStyle = inKerala ? 'kerala' : 'four_slopes';
    if (mainRead.roofStyle !== 'flat' && measured.pitch) mainRead.pitchDeg = Math.round(Math.min(50, Math.max(10, measured.pitch)));
  }
  if (measured?.storeys) read.storeys = measured.storeys;
}

const isKerala = (lat, lng) => lat > 8 && lat < 12.9 && lng > 74.8 && lng < 77.5;

// ---------- 3. parts → designer roof settings ----------

const PITCH = { gentle: 15, normal: 25, steep: 35 };
const COMPASS = { north: 0, north_east: 45, east: 90, south_east: 135, south: 180, south_west: 225, west: 270, north_west: 315 };
const OVERHANG = { none: 0, small: 0.3, wide: 0.9 };

/** Facing of the outline edge closest to `az` (degrees). */
function edgeFacing(pts, az) {
  let best = az;
  let bestDiff = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) continue;
    const f = ((Math.atan2(b.y - a.y, -(b.x - a.x)) / DEG) + 360) % 360; // outward normal of a CCW edge (x east, y north) as a compass bearing
    const diff = Math.abs(((f - az + 540) % 360) - 180) - len * 0.01;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = f;
    }
  }
  return Math.round(best);
}

function roofSettings(part, local, mainLocal) {
  const style = part.roofStyle;
  const pitch = part.pitchDeg ?? (style === 'kerala' ? Math.max(PITCH[part.steepness] || 35, 30) : PITCH[part.steepness] || 25);
  if (style === 'flat') return { roofType: 'flat', parapetH: part.role === 'verandah' ? 0 : 1 };
  if (part.role === 'verandah' && mainLocal) {
    // a lean-to falls away from the house
    const c = centroid(local);
    const m = centroid(mainLocal);
    const away = ((Math.atan2(c.x - m.x, c.y - m.y) / DEG) + 360) % 360;
    return { roofType: 'shed', pitch: Math.min(pitch, 20), slopeAz: edgeFacing(local, away) };
  }
  if (style === 'single_slope') return { roofType: 'shed', pitch, slopeAz: edgeFacing(local, COMPASS[part.slopeDownTowards] ?? 180) };
  if (style === 'two_slopes') return { roofType: 'gable', pitch, slopeAz: null };
  const ends = style === 'kerala' ? (part.ends === 'sloped' ? 'hip' : 'kerala') : part.ends === 'triangle' ? 'gable' : part.ends === 'kerala_gablet' ? 'kerala' : 'hip';
  const overhang = OVERHANG[part.overhang] ?? (style === 'kerala' ? 0.9 : 0.6);
  return { roofType: 'hip', ends, pitch, overhang: style === 'kerala' ? Math.max(overhang, 0.6) : overhang };
}

// One answer per building: the first detection is kept (in memory and in the database) and given
// again for that building, so the same house always gets the same roof. Bump the version when the
// detection changes in a way that should redo old answers.
const DETECT_VERSION = 3;
const CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const memory = boundedCache(200); // the most recent answers only: all of them are in the database (never an endless Map)
const table = () => (mongoose.connection?.readyState === 1 ? mongoose.connection.db.collection('roof_detections') : null);
async function recall(key) {
  const id = `v${DETECT_VERSION}:${key}`;
  const m = memory.get(id);
  if (m && Date.now() - m.at < CACHE_MS) return m.result;
  const row = await table()?.findOne({ _id: id }).catch(() => null);
  if (row && Date.now() - row.at < CACHE_MS) {
    memory.set(id, row);
    return row.result;
  }
  return null;
}
async function remember(keys, result) {
  const at = Date.now();
  for (const key of keys.filter(Boolean)) {
    const id = `v${DETECT_VERSION}:${key}`;
    memory.set(id, { at, result });
    await table()?.updateOne({ _id: id }, { $set: { at, result } }, { upsert: true }).catch((err) => console.error('[roof-detect] could not save:', err.message));
  }
}

/**
 * Detect the roof at a point. Returns { source, ai, confidence, notes, storeys, parts: [{ role,
 * points: [{lat, lng}], roofType, pitch, slopeAz, ends, overhang, parapetH, height }] }.
 */
export async function detectRoof({ lat, lng, referer }) {
  lat = Number(lat);
  lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw badRequest('Valid lat and lng are required.');
  const cacheKey = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const hit = await recall(cacheKey);
  if (hit) return hit;

  const ref = { lat, lng };
  let outline = null;
  let source = 'ai';
  try {
    outline = await googleMaskOutline({ lat, lng, referer });
    if (outline) source = 'google';
  } catch (err) {
    console.error('[roof-detect] Google mask failed:', err.message);
  }
  if (!outline) {
    outline = await osmOutline({ lat, lng });
    if (outline) source = 'osm';
  }
  const outlineLocal = outline ? tidy(outline.points, ref) : null;
  // the same building gives the same answer, wherever on it the pin was dropped
  const buildingKey = outlineLocal ? (() => { const c = toLatLng(centroid(outlineLocal), ref); return `b:${c.lat.toFixed(5)},${c.lng.toFixed(5)}`; })() : null;
  const hitB = buildingKey && (await recall(buildingKey));
  if (hitB) {
    await remember([cacheKey], hitB);
    return hitB;
  }
  const measured = outline?.measured || null;
  const inKerala = isKerala(lat, lng);
  // Google's HIGH / MEDIUM masks line up with the picture; LOW / BASE ones (most of India) and
  // OpenStreetMap are often shifted, so corners are only pulled onto the trusted kind
  const trusted = source === 'google' && ['HIGH', 'MEDIUM'].includes(outline?.quality);

  if (!env.anthropic.apiKey) {
    if (!outlineLocal) throw new HttpError(503, 'Automatic roof detection is not set up yet (the AI key is missing). Draw the roof outline instead.', 'AI_NOT_CONFIGURED');
    const result = finish({ ref, source, ai: false, confidence: 'low', notes: 'Outline found from map data. The AI roof reader is not set up yet, so choose the roof style yourself.', storeys: 1, parts: [{ role: 'main', local: outlineLocal, settings: { roofType: 'flat', parapetH: 1 } }] });
    memory.set(`v${DETECT_VERSION}:${cacheKey}`, { at: Date.now(), result }); // not kept: it has no AI reading yet
    return result;
  }

  // the picture: centred on the building, zoomed so it fills a good part of the frame
  const centre = outlineLocal ? toLatLng(centroid(outlineLocal), ref) : ref;
  const span = outlineLocal ? Math.max(...outlineLocal.map((p) => Math.hypot(p.x - centroid(outlineLocal).x, p.y - centroid(outlineLocal).y))) * 2 : 30;
  const zoom = span < 28 ? 21 : 20;
  const frame = staticMapFrame({ center: centre, zoom, size: IMAGE_SIZE, scale: IMAGE_SCALE });
  const outlineLatLng = outlineLocal?.map((p) => toLatLng(p, ref));
  const image = await staticMap({ query: { lat: centre.lat, lng: centre.lng, zoom, w: IMAGE_SIZE, h: IMAGE_SIZE, pts: outlineLatLng?.map((p) => `${p.lat},${p.lng}`).join(';') }, referer });
  const read = await askClaude({ image, frame, outlinePx: outlineLatLng?.map(frame.toPixel), facts: factsFor(measured, inKerala) });
  applyFacts(read, measured, inKerala);

  if (!read.houseFound || !read.parts?.length) {
    throw new HttpError(404, read.notes || 'No house roof was found at this spot. Move the pin onto the house and try again.', 'NO_ROOF');
  }
  // the main roof first, then upper floors, then verandahs
  const order = { main: 0, upper: 1, verandah: 2 };
  const parts = [...read.parts].sort((a, b) => order[a.role] - order[b.role]);
  if (parts[0].role !== 'main') parts[0] = { ...parts[0], role: 'main' };

  const toLocalPx = (corners) => corners.map((c) => toLocal(frame.toLatLng(c), ref));
  const traced = (part) => {
    if (part.corners.length < 3) return null;
    const raw = ensureCCW(cleanRing(toLocalPx(part.corners), 0.3, 5));
    return raw.length >= 3 && Math.abs(signedArea(raw)) >= 2 ? raw : null;
  };
  // one wall direction for the whole house, so every part squares up the same way
  const mainPart = parts.find((p) => p.role === 'main');
  const mainUse = mainPart && read.outlineMatchesMainRoof && trusted ? outlineLocal : mainPart && traced(mainPart);
  const angle = mainUse ? dominantAngle(mainUse) : outlineLocal ? dominantAngle(outlineLocal) : 0;
  // a sloped roof needs square corners (cut corners and small bays are squared off); a flat roof keeps its shape
  const shape = (local, part) => ensureCCW(part.roofStyle === 'flat' ? squareUp(local, 18, angle) : squareUp(local, 44, angle, 1.2));

  const built = [];
  let mainLocal = null;
  for (const part of parts) {
    if (part.role === 'main' && built.some((b) => b.role === 'main')) part.role = 'upper';
    let local = part.role === 'main' ? mainUse : traced(part);
    if (!local) continue;
    // the AI's corners are rough: pull them onto the measured outline / the main roof, then square up
    // (in this order, so the result stays square)
    if (!(part.role === 'main' && local === outlineLocal)) {
      const targets = [...(trusted ? outlineLocal : []), ...(mainLocal || [])];
      if (targets.length) local = ensureCCW(snapCorners(local, targets, part.role === 'main' ? 1.2 : 0.8));
    }
    local = shape(local, part);
    if (part.role === 'main') mainLocal = local;
    built.push({ role: part.role, part, local });
  }
  // lower roofs inside the main outline (flat side rooms, porches under the same outline) are cut out
  // of the main roof, so it doesn't cover them
  const main = built.find((b) => b.role === 'main');
  if (main) {
    const inside = built.filter((b) => b.role === 'verandah' && b.local.some((q) => pointInPolygon(q, main.local)));
    if (inside.length) {
      main.local = shape(squareSubtract(main.local, inside.map((b) => b.local), angle), main.part);
      mainLocal = main.local;
    }
  }
  for (const b of built) b.settings = roofSettings(b.part, b.local, mainLocal);
  if (!mainLocal) throw new HttpError(404, 'The roof could not be traced. Draw the outline instead.', 'NO_ROOF');

  const result = finish({ ref, source: read.outlineMatchesMainRoof && trusted ? source : 'ai', ai: true, confidence: read.confidence, notes: read.notes, storeys: read.storeys, parts: built, measured });
  await remember([cacheKey, buildingKey], result);
  return result;
}

/** Heights per part and lat/lng outlines. */
function finish({ ref, source, ai, confidence, notes, storeys, parts, measured }) {
  const floors = Math.min(5, Math.max(1, Math.round(storeys) || 1));
  // a measured wall height beats "storeys × 3 m" when it is believable
  const mainH = measured?.eaveHeight > 2 && measured.eaveHeight < 20 ? Math.round(measured.eaveHeight * 2) / 2 : floors * 3;
  return {
    source,
    ai,
    confidence,
    notes,
    storeys: floors,
    parts: parts.map((p) => ({
      role: p.role,
      points: p.local.map((q) => toLatLng(q, ref)),
      // an upper floor stands one storey above the main walls; a verandah's edge sits a little below them
      // the survey measures the roof's lowest edge; with an overhang the wall top is that much higher
      height: p.role === 'upper' ? mainH + 3 : p.role === 'verandah' ? Math.max(2.4, Math.min(mainH, 3) - 0.6) : Math.round((mainH + (measured && p.settings.roofType === 'hip' ? p.settings.overhang * Math.tan((p.settings.pitch * Math.PI) / 180) : 0)) * 10) / 10,
      ...p.settings,
    })),
  };
}

/**
 * The user has drawn the roof: their outline is the main roof, exactly. Only what is inside it is
 * read — flat or sloped, style and pitch (measured where Google has a height map), and any higher
 * roof standing inside it. Nothing outside the outline is returned.
 */
export async function detectInOutline({ outline, referer }) {
  const poly = Array.isArray(outline) ? outline.map((p) => ({ lat: Number(p?.lat), lng: Number(p?.lng) })) : [];
  if (poly.length < 3 || poly.length > 200 || !poly.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180)) throw badRequest('The roof outline is not valid.');
  const ref = { lat: poly.reduce((t, p) => t + p.lat, 0) / poly.length, lng: poly.reduce((t, p) => t + p.lng, 0) / poly.length };
  const local = ensureCCW(poly.map((p) => toLocal(p, ref)));
  if (Math.abs(signedArea(local)) < 4) throw badRequest('The roof outline is too small.');
  const key = `u:${crypto.createHash('sha1').update(poly.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join(';')).digest('hex')}`;
  const hit = await recall(key);
  if (hit) return hit;

  const span = Math.max(...local.map((p) => Math.hypot(p.x, p.y)));
  const inKerala = isKerala(ref.lat, ref.lng);
  let measured = null;
  try {
    measured = (await googleMaskOutline({ lat: ref.lat, lng: ref.lng, referer, userPoly: poly, radius: span + 10 }))?.measured || null;
  } catch (err) {
    console.error('[roof-detect] height map failed:', err.message);
  }
  const mainSettings = (style, pitchDeg, steepness = 'normal', ends = 'kerala_gablet') => roofSettings({ role: 'main', roofStyle: style, pitchDeg, steepness, ends, overhang: style === 'kerala' ? 'wide' : 'small', slopeDownTowards: 'none' }, local, null);

  if (!env.anthropic.apiKey) {
    const flat = !measured || measured.flatShare > 0.6;
    const style = flat ? 'flat' : inKerala ? 'kerala' : 'four_slopes';
    const pitch = flat ? undefined : Math.round(Math.min(50, Math.max(10, measured.pitch || 25)));
    const result = finish({ ref, source: 'drawn', ai: false, confidence: measured ? 'medium' : 'low', notes: measured ? 'Roof style from the 3D height survey inside your outline.' : 'No height survey here and the AI is not set up: choose the roof style yourself.', storeys: measured?.storeys || 1, parts: [{ role: 'main', local, settings: mainSettings(style, pitch) }], measured });
    return result;
  }

  const zoom = span * 2 < 28 ? 21 : 20;
  const frame = staticMapFrame({ center: ref, zoom, size: IMAGE_SIZE, scale: IMAGE_SCALE });
  const image = await staticMap({ query: { lat: ref.lat, lng: ref.lng, zoom, w: IMAGE_SIZE, h: IMAGE_SIZE, pts: poly.map((p) => `${p.lat},${p.lng}`).join(';') }, referer });
  const read = await askClaude({
    image,
    frame,
    outlinePx: poly.map(frame.toPixel),
    facts: factsFor(measured, inKerala),
    userDrawn: true,
    extra: 'Describe the roof inside the amber outline. Give one "main" part (its corners can simply be the amber corners) with its style, and an "upper" part only for a clearly higher roof standing inside the outline. Do not return verandah parts.',
  });
  applyFacts(read, measured, inKerala);
  const mainRead = read.parts?.find((p) => p.role === 'main') || { roofStyle: measured && measured.flatShare < 0.4 ? (inKerala ? 'kerala' : 'four_slopes') : 'flat', steepness: 'normal', ends: 'sloped', overhang: 'small' };
  const parts = [{ role: 'main', local, settings: roofSettings({ ...mainRead, role: 'main' }, local, null) }];
  // a higher roof inside the outline: kept only when it really lies inside, then squared like the main roof
  const angle = dominantAngle(local);
  for (const part of read.parts || []) {
    if (part.role !== 'upper' || part.corners.length < 3) continue;
    let up = ensureCCW(cleanRing(part.corners.map((c) => toLocal(frame.toLatLng(c), ref)), 0.3, 5));
    if (up.length < 3 || Math.abs(signedArea(up)) < 4) continue;
    up = ensureCCW(squareUp(snapCorners(up, local, 0.8), 44, angle, 1.2));
    if (!up.every((q) => pointInPolygon(q, local) || local.some((v) => Math.hypot(v.x - q.x, v.y - q.y) < 0.05))) continue;
    if (Math.abs(signedArea(up)) > Math.abs(signedArea(local)) * 0.9) continue;
    parts.push({ role: 'upper', local: up, settings: roofSettings(part, up, local) });
  }
  const result = finish({ ref, source: 'drawn', ai: true, confidence: read.confidence, notes: read.notes, storeys: read.storeys, parts, measured });
  // the user's outline is kept exactly as drawn (no squaring here: the 3D model squares hip roofs itself)
  result.parts[0].points = poly;
  await remember([key], result);
  return result;
}

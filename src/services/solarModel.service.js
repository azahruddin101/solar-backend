// The designer's house model, straight from Google's Solar API (the methodology of Google's
// js-solar-potential sample): no roof is drawn or guessed.
//
// - buildingInsights gives the roof faces (roofSegmentStats: pitch, azimuth, plane height) and
//   Google's own panel layout (solarPanels: centre, orientation, face). Every face that holds panels
//   becomes a measured roof plane: its outline is the area Google's panels cover on it.
// - dataLayers gives the height map (DSM) and aerial photo (RGB) of the building and its
//   surroundings: the 3D view shows that real surface, photo on top.
//
// Everything is returned in local metres around the requested point (x east, y north), heights in
// metres above the ground. Results are kept for 30 days (Google's caching limit for this API).

import { boundedCache } from '../utils/boundedCache.js';
import { createHash } from 'node:crypto';
import { fromArrayBuffer } from 'geotiff';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { HttpError, badRequest } from '../utils/HttpError.js';
import { cleanRing, dominantAngle, ensureCCW, outlineOfComponent, pointInPolygon, simplifyRing, splitRoofComponents, squareUp, toLatLng as toLatLngOf, toLocal, traceMaskOutline, utmToLatLng, utmZoneOf } from '../utils/roofOutline.js';
import { buildingInsights } from './google.service.js';

const DATA_LAYERS = 'https://solar.googleapis.com/v1/dataLayers:get';
const DEG = Math.PI / 180;
const MODEL_VERSION = 7;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const HOUSE_MAX = 300; // roof height grid cells per side (0.2 m on most houses)
const PHOTO_MAX = 640; // photo pixels per side

// Each model is large (roof height grids and a photo for every building: several MB). Only the few used most
// recently stay in memory; every model is in the database too. (An unbounded Map here grew by one model for every
// roof outline ever asked for and was never emptied: the server's memory climbed until it was restarted.)
const memory = boundedCache(6);
const table = () => (mongoose.connection?.readyState === 1 ? mongoose.connection.db.collection('solar_models') : null);

/** Convex hull (monotone chain), counter-clockwise. */
function hull(points) {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const percentile = (values, q) => {
  const a = Float64Array.from(values).sort();
  return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))] : null;
};

/** One GeoTIFF from a data-layers URL: { image, rasters }. */
async function geoTiff(url, referer, interleave = false) {
  const u = new URL(url);
  u.searchParams.set('key', env.googleKey);
  const res = await fetch(u, { headers: referer ? { Referer: referer } : {} });
  if (!res.ok) throw new Error(`layer download ${res.status}`);
  const image = await (await fromArrayBuffer(await res.arrayBuffer())).getImage();
  return { image, rasters: await image.readRasters(interleave ? { interleave: true } : undefined) };
}

/** Height map + photo around the building, as a grid in local metres (null when Google has none). */
async function surface({ center, radius, ref, referer, boxes, faces, areas }) {
  let layers = null;
  for (const quality of ['HIGH', 'MEDIUM', 'LOW', 'BASE']) {
    const params = new URLSearchParams({ 'location.latitude': center.lat.toFixed(7), 'location.longitude': center.lng.toFixed(7), radiusMeters: String(Math.round(Math.min(60, Math.max(20, radius)))), view: 'IMAGERY_LAYERS', requiredQuality: quality, pixelSizeMeters: '0.1', key: env.googleKey });
    if (quality === 'BASE') params.set('experiments', 'EXPANDED_COVERAGE');
    const res = await fetch(`${DATA_LAYERS}?${params}`, { headers: referer ? { Referer: referer } : {} }).catch(() => null);
    if (!res) return null;
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.dsmUrl) {
      layers = body;
      break;
    }
    if (res.status !== 404 && res.status !== 400) {
      console.error(`[solar-model] dataLayers ${res.status}: ${body?.error?.message || ''}`);
      return null;
    }
  }
  if (!layers) return null;
  const [dsm, mask, rgb] = await Promise.all([geoTiff(layers.dsmUrl, referer), geoTiff(layers.maskUrl, referer), geoTiff(layers.rgbUrl, referer, true)]);
  const zone = utmZoneOf((dsm.image.getGeoKeys() || {}).ProjectedCSTypeGeoKey);
  if (!zone) return null;
  const W = dsm.image.getWidth();
  const H = dsm.image.getHeight();
  const [ox, oy] = dsm.image.getOrigin();
  const res = dsm.image.getResolution();
  const rx = Math.abs(res[0]);
  const ry = -Math.abs(res[1]); // rows run south
  const z = dsm.rasters[0];
  const roof = mask.image.getWidth() === W && mask.image.getHeight() === H ? mask.rasters[0] : null;
  const valid = (v) => Number.isFinite(v) && v > -1000;

  // the ground: low part of the open land (not roof) — trees and buildings stand higher
  const open = [];
  for (let i = 0; i < z.length; i += 3) if (valid(z[i]) && (!roof || !roof[i])) open.push(z[i]);
  const ground = percentile(open.length > 50 ? open : Array.from(z).filter(valid), 0.1);

  // pixel ↔ local metres (affine; handles the slight UTM rotation)
  const at = (i, j) => toLocal(utmToLatLng({ x: ox + i * rx, y: oy + j * ry }, zone), ref);
  const o = at(0, 0);
  const ex = at(W, 0);
  const ey = at(0, H);
  const A = { a: (ex.x - o.x) / W, b: (ey.x - o.x) / H, c: (ex.y - o.y) / W, d: (ey.y - o.y) / H };
  const pxToLocal = (i, j) => ({ x: o.x + A.a * i + A.b * j, y: o.y + A.c * i + A.d * j });
  const det = A.a * A.d - A.b * A.c;
  const localToPx = (p) => ({ i: (A.d * (p.x - o.x) - A.b * (p.y - o.y)) / det, j: (-A.c * (p.x - o.x) + A.a * (p.y - o.y)) / det });

  // roofs inside the mark (or Google's face boxes when only a pin was set). Low pixels are alleys
  // Google painted as roof. When the user marked an area, every building in it is kept — not only
  // the one under the middle — and thin bridges between neighbours are split.
  const houses = [];
  if (roof) {
    const inBoxes = areas
      ? (p) => areas.some((a) => pointInPolygon(p, a))
      : (p) => !boxes.length || boxes.some((b) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1);
    const cand = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (!roof[k] || !inBoxes(pxToLocal(i + 0.5, j + 0.5))) continue;
        if (valid(z[k]) && z[k] - ground < 1.5) continue;
        cand[k] = 1;
      }
    }
    const minPx = Math.max(80, Math.round(20 / (rx * rx)));
    const radiusPx = Math.max(2, Math.round(1.2 / rx));
    let comps;
    if (areas) {
      comps = splitRoofComponents(cand, W, H, { radiusPx, minPx }).slice(0, 8);
    } else {
      const c = localToPx(toLocal(center, ref));
      const ring = traceMaskOutline(cand, W, H, c.i, c.j, Math.round(4 / rx));
      comps = ring?.component ? [ring.component] : [];
    }
    const planeFaces = faces.map((f) => ({ ...f, h: f.hAbs - ground }));
    for (const comp of comps) {
      const ring = outlineOfComponent(comp, W, H);
      if (!ring) continue;
      const rough = ensureCCW(cleanRing(simplifyRing(ring.map((q) => pxToLocal(q.x, q.y)), 0.3), 0.3, 6));
      const outline = rough.length >= 4 ? ensureCCW(squareUp(rough, 15, dominantAngle(rough), 0.8)) : rough;
      if (outline.length < 3) continue;
      const ownFaces = planeFaces.filter((f) => pointInPolygon(f.c, outline));
      const mesh = houseMesh({ W, H, z, ground, comp, rgb, pxToLocal, valid, faces: ownFaces });
      if (mesh) houses.push({ ...mesh, footprint: outline });
    }
  }
  const house = houses[0] || null;

  // heights inside an outline (local metres), for fitting each roof face onto the measured surface
  const probe = (poly, fn) => {
    const px = poly.map(localToPx);
    const is = px.map((q) => q.i);
    const js = px.map((q) => q.j);
    const inside = (q) => {
      let hit = false;
      for (let k = 0, l = px.length - 1; k < px.length; l = k++) {
        if (px[k].j > q.j !== px[l].j > q.j && q.i < ((px[l].i - px[k].i) * (q.j - px[k].j)) / (px[l].j - px[k].j) + px[k].i) hit = !hit;
      }
      return hit;
    };
    for (let j = Math.max(0, Math.floor(Math.min(...js))); j < Math.min(H, Math.ceil(Math.max(...js))); j += 2) {
      for (let i = Math.max(0, Math.floor(Math.min(...is))); i < Math.min(W, Math.ceil(Math.max(...is))); i += 2) {
        const v = z[j * W + i];
        if (!valid(v) || !inside({ i: i + 0.5, j: j + 0.5 })) continue;
        fn(pxToLocal(i + 0.5, j + 0.5), v - ground);
      }
    }
  };
  return { probe, ground, quality: layers.imageryQuality, date: layers.imageryDate, house: house && { ...house, footprint: house.footprint }, houses };
}

/**
 * The building alone: its roof as a height grid over the footprint's box (−1 = not this building)
 * and the photo cropped to the same box. Vertex (c, r) is pixel (i0 + c·step, j0 + r·step).
 */
function houseMesh({ W, H, z, ground, comp, rgb, pxToLocal, valid, faces = [] }) {
  let i0 = W;
  let i1 = -1;
  let j0 = H;
  let j1 = -1;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (!comp[j * W + i]) continue;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
    }
  }
  if (i1 < i0) return null;
  i0 = Math.max(0, i0 - 2);
  j0 = Math.max(0, j0 - 2);
  i1 = Math.min(W - 1, i1 + 2);
  j1 = Math.min(H - 1, j1 + 2);
  const step = Math.max(2, Math.ceil(Math.max(i1 - i0, j1 - j0) / HOUSE_MAX));
  const cols = Math.floor((i1 - i0) / step) + 1;
  const rows = Math.floor((j1 - j0) / step) + 1;
  // the roof's outermost pixels mix roof and ground: heights are read 0.3 m in from the edge
  const o0 = pxToLocal(0, 0);
  const o1 = pxToLocal(1, 0);
  const pxM = Math.hypot(o1.x - o0.x, o1.y - o0.y) || 0.1;
  const ERODE = Math.max(1, Math.round(0.3 / pxM));
  const core = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (!comp[j * W + i]) continue;
      let ok = true;
      for (let d = 1; d <= ERODE && ok; d++) {
        if (!comp[j * W + Math.min(W - 1, i + d)] || !comp[j * W + Math.max(0, i - d)] || !comp[Math.min(H - 1, j + d) * W + i] || !comp[Math.max(0, j - d) * W + i]) ok = false;
      }
      core[j * W + i] = ok ? 1 : 0;
    }
  }
  // Google's flat roof faces, each nudged to sit on the height map
  const planes = faces.map((f) => ({ ...f, offset: 0 }));
  const planeZ = (pl, p) => pl.h - pl.tan * ((p.x - pl.c.x) * pl.f.x + (p.y - pl.c.y) * pl.f.y) + pl.offset;
  const near = (pl, p) => p.x >= pl.box.x0 - 1 && p.x <= pl.box.x1 + 1 && p.y >= pl.box.y0 - 1 && p.y <= pl.box.y1 + 1;
  for (const pl of planes) {
    const res = [];
    for (let j = j0; j <= j1; j += 3) {
      for (let i = i0; i <= i1; i += 3) {
        if (!core[j * W + i] || !valid(z[j * W + i])) continue;
        const p = pxToLocal(i + 0.5, j + 0.5);
        if (!near(pl, p)) continue;
        const r = z[j * W + i] - ground - planeZ(pl, p);
        if (Math.abs(r) < 0.6) res.push(r);
      }
    }
    if (res.length >= 10) pl.offset = percentile(res, 0.5);
  }
  // the roof, point by point: which of Google's flat faces it is on. The height map is noisy (and
  // wrong at the edges, where roof and ground mix), so where a face fits the roof, the roof IS that
  // face — clean flat slopes, sharp ridges and hips; the eaves continue the face out to the walls.
  // Only a sizeable part no face fits (a tank, a stair room, a flat terrace) keeps its measured shape.
  const N = cols * rows;
  const meas = new Float32Array(N).fill(NaN); // smoothed height map, on the roof's core only
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = i0 + c * step;
      const j = j0 + r * step;
      if (!core[j * W + i]) continue;
      // the median of the 5 × 5 pixels around it on this roof: smooth, still sharp at ridges
      const vs = [];
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= W || jj >= H || !core[jj * W + ii] || !valid(z[jj * W + ii])) continue;
          vs.push(z[jj * W + ii]);
        }
      }
      if (vs.length >= 5) meas[r * cols + c] = percentile(vs, 0.5) - ground;
    }
  }
  const OWN = planes.length; // label: "its own shape"
  const NONE = -1;
  const label = new Int16Array(N).fill(NONE);
  const pointAt = (c, r) => pxToLocal(i0 + c * step + 0.5, j0 + r * step + 0.5);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = meas[r * cols + c];
      if (Number.isNaN(v)) continue;
      const p = pointAt(c, r);
      let best = OWN;
      let bd = 0.45;
      planes.forEach((pl, k) => {
        if (!near(pl, p)) return;
        const d = Math.abs(v - planeZ(pl, p));
        if (d < bd) {
          bd = d;
          best = k;
        }
      });
      label[r * cols + c] = best;
    }
  }
  // tidy the labels: each point takes the most common label around it (about 1 m), twice — specks of
  // noise go, the borders between faces straighten
  const R = Math.max(1, Math.round(0.5 / (step * pxM)));
  for (let pass = 0; pass < 2; pass++) {
    const prev = label.slice();
    const count = new Int32Array(OWN + 1);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (prev[r * cols + c] === NONE) continue;
        count.fill(0);
        for (let dr = -R; dr <= R; dr++) {
          for (let dc = -R; dc <= R; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
            const l = prev[rr * cols + cc];
            if (l !== NONE) count[l] += 1;
          }
        }
        let top = prev[r * cols + c];
        for (let l = 0; l <= OWN; l++) if (count[l] > count[top]) top = l;
        label[r * cols + c] = top;
      }
    }
  }
  // a thin strip of its own shape (under about 1 m wide, e.g. the roof's edge mixed with the ground
  // or a tree) is noise too: only what survives shrinking by 0.5 m and growing back is kept
  const E = Math.max(1, Math.round(0.5 / (step * pxM)));
  const isOwn = (lab, c, r) => r >= 0 && c >= 0 && r < rows && c < cols && lab[r * cols + c] === OWN;
  const shrunk = new Uint8Array(N);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isOwn(label, c, r)) continue;
      let ok = true;
      for (let dr = -E; dr <= E && ok; dr++) for (let dc = -E; dc <= E && ok; dc++) if (!isOwn(label, c + dc, r + dr)) ok = false;
      shrunk[r * cols + c] = ok ? 1 : 0;
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isOwn(label, c, r)) continue;
      let keep = false;
      for (let dr = -E; dr <= E && !keep; dr++) {
        for (let dc = -E; dc <= E && !keep; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && cc >= 0 && rr < rows && cc < cols && shrunk[rr * cols + cc]) keep = true;
        }
      }
      if (!keep && planes.length) label[r * cols + c] = NONE;
    }
  }
  // a part of its own shape smaller than about 1.5 m² is noise: it joins the face next to it
  const seen = new Uint8Array(N);
  const minOwn = Math.ceil(1.5 / (step * pxM) ** 2);
  for (let s0 = 0; s0 < N; s0++) {
    if (label[s0] !== OWN || seen[s0]) continue;
    const blob = [s0];
    seen[s0] = 1;
    for (let q = 0; q < blob.length; q++) {
      const k = blob[q];
      const c = k % cols;
      const r = (k - c) / cols;
      for (const [nc, nr] of [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]) {
        const n = nr * cols + nc;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || seen[n] || label[n] !== OWN) continue;
        seen[n] = 1;
        blob.push(n);
      }
    }
    if (blob.length < minOwn && planes.length) for (const k of blob) label[k] = NONE;
  }
  // every point of the grid gets the label of the nearest labelled roof point (breadth-first): the
  // roof's edge and the points the tidying freed up continue the face beside them
  const from = new Int32Array(N).fill(-1);
  const queue = [];
  for (let k = 0; k < N; k++) {
    if (label[k] !== NONE) {
      from[k] = k;
      queue.push(k);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q];
    const c = k % cols;
    const r = (k - c) / cols;
    for (const [nc, nr] of [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]) {
      const n = nr * cols + nc;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || from[n] >= 0) continue;
      from[n] = from[k];
      label[n] = label[k];
      queue.push(n);
    }
  }
  const heightsCm = new Array(N).fill(-1);
  const lowest = percentile(Array.from(meas).filter((v) => !Number.isNaN(v)), 0.02) ?? 0;
  for (let k = 0; k < N; k++) {
    const l = label[k];
    if (l === NONE) continue;
    const c = k % cols;
    const r = (k - c) / cols;
    let v;
    if (l < OWN) {
      // labels went to the face nearest the measured roof, so where two faces meet the roof
      // follows the lower one at a ridge or hip and the higher one in a valley
      v = planeZ(planes[l], pointAt(c, r));
    } else {
      const src = from[k];
      v = Number.isNaN(meas[k]) ? meas[src] : meas[k];
    }
    // the eaves never drop far below the lowest measured roof
    heightsCm[k] = Math.max(0, Math.round(Math.max(v, lowest - 0.6) * 100));
  }
  // the photo of the same box, at up to PHOTO_MAX pixels a side
  const rw = rgb.image.getWidth();
  const rh = rgb.image.getHeight();
  const sx = rw / W;
  const sy = rh / H;
  const bw = Math.round((i1 - i0) * sx);
  const bh = Math.round((j1 - j0) * sy);
  const ps = Math.max(1, Math.ceil(Math.max(bw, bh) / PHOTO_MAX));
  const pw = Math.max(1, Math.floor(bw / ps));
  const ph = Math.max(1, Math.floor(bh / ps));
  const bytes = Buffer.alloc(pw * ph * 3);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const s = ((Math.round(j0 * sy) + y * ps) * rw + Math.round(i0 * sx) + x * ps) * 3;
      bytes.set([rgb.rasters[s], rgb.rasters[s + 1], rgb.rasters[s + 2]], (y * pw + x) * 3);
    }
  }
  const o = pxToLocal(i0, j0);
  const ex = pxToLocal(i0 + (cols - 1) * step, j0);
  const ey = pxToLocal(i0, j0 + (rows - 1) * step);
  const pex = pxToLocal(i1, j0);
  const pey = pxToLocal(i0, j1);
  return {
    origin: o,
    ux: { x: ex.x - o.x, y: ex.y - o.y }, // across the whole grid
    uy: { x: ey.x - o.x, y: ey.y - o.y },
    cols,
    rows,
    heightsCm,
    // the photo spans the box; the grid may stop a little short of its far edges
    photoSpan: { x: Math.hypot(ex.x - o.x, ex.y - o.y) / Math.hypot(pex.x - o.x, pex.y - o.y), y: Math.hypot(ey.x - o.x, ey.y - o.y) / Math.hypot(pey.x - o.x, pey.y - o.y) },
    photo: { width: pw, height: ph, rgb: bytes.toString('base64') },
  };
}

/** One marked outline: [{lat, lng}] from "lat,lng;lat,lng;…" (or an array of points). */
function parseOutline(outline) {
  const raw = Array.isArray(outline) ? outline : String(outline).split(';').map((q) => q.split(','));
  const pts = raw.map((q) => (Array.isArray(q) ? { lat: Number(q[0]), lng: Number(q[1]) } : { lat: Number(q.lat), lng: Number(q.lng) }));
  if (pts.length < 3 || pts.length > 60 || pts.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180)) throw badRequest('The marked roof area is not valid.');
  return pts.map((p) => ({ lat: Math.round(p.lat * 1e7) / 1e7, lng: Math.round(p.lng * 1e7) / 1e7 }));
}

const MAX_OUTLINES = 12;
/**
 * The roofs the user marked, one outline per building: "lat,lng;…|lat,lng;…" (outlines separated by
 * "|"), or an array of outlines / of points. Null when only a pin was set.
 */
function parseOutlines(outline) {
  if (!outline) return null;
  let list;
  if (Array.isArray(outline)) list = outline.length && Array.isArray(outline[0]) && (Array.isArray(outline[0][0]) || typeof outline[0][0] === 'object') ? outline : [outline];
  else list = String(outline).split('|').filter((s) => s.trim());
  if (!list.length || list.length > MAX_OUTLINES) throw badRequest('The marked roof area is not valid.');
  return list.map(parseOutline);
}

/** The farthest point of an area from `c` (metres). */
const reach = (pts, c) => Math.max(...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y)));

/** The middle of a marked area (the centroid of its shape). */
function areaCentre(pts) {
  let a = 0;
  let x = 0;
  let y = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const k = pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    a += k;
    x += (pts[j].x + pts[i].x) * k;
    y += (pts[j].y + pts[i].y) * k;
  }
  if (Math.abs(a) < 1e-9) return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  return { x: x / (3 * a), y: y / (3 * a) };
}

/** Inside the area, or within `d` metres of its edge. */
function nearArea(p, pts, d) {
  if (pointInPolygon(p, pts)) return true;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y) <= d) return true;
  }
  return false;
}

/**
 * The measured roof planes (from Google's panel layout) and the real surface for the 3D view.
 * { center, quality, imageryDate, panel: {widthM, heightM, watts}, planes: [{ id, points, pitch,
 *   azimuth, height, centre, googlePanels, sunshineHours }], mesh, maxPanels }
 */
export async function solarModel({ lat, lng, outline = null, referer }) {
  lat = Number(lat);
  lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw badRequest('Valid lat and lng are required.');
  const marked = parseOutlines(outline);
  const key = `v${MODEL_VERSION}:${lat.toFixed(6)},${lng.toFixed(6)}${marked ? `:${createHash('sha1').update(JSON.stringify(marked)).digest('hex').slice(0, 16)}` : ''}`;
  const m = memory.get(key);
  if (m && Date.now() - m.at < KEEP_MS) return m.result;
  const row = await table()?.findOne({ _id: key }).catch(() => null);
  if (row && Date.now() - row.at < KEEP_MS) {
    memory.set(key, row);
    return row.result;
  }

  const ref = { lat, lng };
  // the roof the user marked (local metres): Google's building is looked up at its middle, and only
  // its faces, panels and surface inside the mark are used
  // the roofs the user marked (local metres), one outline per building: Google's building is looked up
  // at the middle of each, and only faces, panels and surface inside the marks are used
  const areas = marked ? marked.map((poly) => ensureCCW(poly.map((p) => toLocal(p, ref)))) : null;
  const area = areas?.[0] || null;
  const multi = Boolean(areas && areas.length > 1);
  const inAreas = (p) => !areas || areas.some((a) => pointInPolygon(p, a));
  const nearAreas = (p, d) => !areas || areas.some((a) => nearArea(p, a, d));
  const look = area ? toLatLngOf(areaCentre(area), ref) : { lat, lng };
  const insights = await buildingInsights({ lat: look.lat, lng: look.lng, referer });
  const sp = insights.solarPotential || {};
  const inMark = (g) => !g.center || nearAreas(toLocal({ lat: g.center.latitude, lng: g.center.longitude }, ref), 1);
  const takeInsights = (body) => {
    const segs = body.solarPotential?.roofSegmentStats || [];
    const kept = segs.map(inMark);
    const panelsIn = (body.solarPotential?.solarPanels || []).filter((p) => kept[p.segmentIndex] && inAreas(toLocal({ lat: p.center.latitude, lng: p.center.longitude }, ref)));
    return { segs: segs.map((g, i) => (kept[i] ? g : {})), panels: panelsIn, kept };
  };
  const first = takeInsights(insights);
  let segments = first.segs;
  let panels = first.panels;
  const keep = first.kept;
  // with several roofs marked, the others are looked up below before giving up
  if (!multi && area && !keep.some(Boolean)) throw new HttpError(404, 'Google has no roof data inside the area you marked. Check the box covers your roof and try again.', 'NO_LAYOUT');
  if (!multi && (!keep.some(Boolean) || !panels.length)) throw new HttpError(404, area ? 'Google found no room for panels inside the area you marked. Make the box cover the whole roof and try again.' : 'Google has no roof layout for this building. Move the pin onto the middle of the roof and try again.', 'NO_LAYOUT');
  const pw = sp.panelWidthMeters || 1.045;
  const plh = sp.panelHeightMeters || 1.879;
  const center = { lat: insights.center.latitude, lng: insights.center.longitude };
  const bb = insights.boundingBox;
  const radius = bb ? Math.max(...[bb.sw, bb.ne].map((p) => Math.hypot(...Object.values(toLocal({ lat: p.latitude, lng: p.longitude }, center))))) + 6 : 30;

  // this building's own roof faces, as boxes in local metres (they cut joined neighbours off)
  const boxes = segments.filter((g) => g.boundingBox).map((g) => {
    const a = toLocal({ lat: g.boundingBox.sw.latitude, lng: g.boundingBox.sw.longitude }, ref);
    const b = toLocal({ lat: g.boundingBox.ne.latitude, lng: g.boundingBox.ne.longitude }, ref);
    return { x0: Math.min(a.x, b.x) - 0.4, x1: Math.max(a.x, b.x) + 0.4, y0: Math.min(a.y, b.y) - 0.4, y1: Math.max(a.y, b.y) + 0.4 };
  });
  // Google's roof faces as planes (heights above sea level; the ground is taken off in surface())
  const faces = segments.filter((g) => g.center && g.planeHeightAtCenterMeters != null && g.boundingBox).map((g) => {
    const az = (g.azimuthDegrees ?? 180) * DEG;
    const p = toLocal({ lat: g.boundingBox.sw.latitude, lng: g.boundingBox.sw.longitude }, ref);
    const q = toLocal({ lat: g.boundingBox.ne.latitude, lng: g.boundingBox.ne.longitude }, ref);
    const b = { x0: Math.min(p.x, q.x), x1: Math.max(p.x, q.x), y0: Math.min(p.y, q.y), y1: Math.max(p.y, q.y) };
    return { c: toLocal({ lat: g.center.latitude, lng: g.center.longitude }, ref), f: { x: Math.sin(az), y: Math.cos(az) }, tan: Math.tan((g.pitchDegrees ?? 0) * DEG), hAbs: g.planeHeightAtCenterMeters, box: b };
  });
  const surf = env.googleKey ? await surface({ center, radius: areas ? Math.max(radius, ...areas.map((a) => reach(a, toLocal(center, ref)) + 4)) : radius, ref, referer, boxes, faces, areas }).catch((err) => (console.error('[solar-model] surface:', err.message), null)) : null;
  const ground = surf?.ground;
  // a second building in the mark is a different Google building: read its faces too
  const seen = [{ lat: center.lat, lng: center.lng }];
  const nearSeen = (ll) => seen.some((p) => {
    const a = toLocal(p, ref);
    const b = toLocal(ll, ref);
    return Math.hypot(a.x - b.x, a.y - b.y) < 8;
  });
  // …and so is every other roof the user marked, looked up at its own middle
  const spots = [...(surf?.houses || []).filter((h) => h.footprint?.length).map((h) => areaCentre(h.footprint)), ...(areas || []).slice(1).map(areaCentre)];
  for (const spot of spots) {
    const ll = toLatLngOf(spot, ref);
    if (nearSeen(ll)) continue;
    let extra;
    try {
      extra = await buildingInsights({ lat: ll.lat, lng: ll.lng, referer });
    } catch {
      continue;
    }
    const extraC = { lat: extra.center.latitude, lng: extra.center.longitude };
    if (nearSeen(extraC)) continue;
    seen.push(extraC);
    const more = takeInsights(extra);
    if (!more.kept.some(Boolean)) continue;
    const offset = segments.length;
    segments = segments.concat(more.segs);
    panels = panels.concat(more.panels.map((p) => ({ ...p, segmentIndex: p.segmentIndex + offset })));
  }
  if (multi && !panels.length) throw new HttpError(404, 'Google has no roof data inside the areas you marked. Check each one covers its roof and try again.', 'NO_LAYOUT');

  // each face Google placed panels on: the area those panels cover, as a convex outline
  const bySeg = new Map();
  for (const p of panels) {
    const seg = segments[p.segmentIndex];
    if (!seg) continue;
    const az = seg.azimuthDegrees ?? 180;
    const pitch = seg.pitchDegrees ?? 0;
    const f = { x: Math.sin(az * DEG), y: Math.cos(az * DEG) }; // downhill
    const cdir = { x: Math.cos(az * DEG), y: -Math.sin(az * DEG) }; // across the slope
    const c = toLocal({ lat: p.center.latitude, lng: p.center.longitude }, ref);
    const orient = p.orientation === 'PORTRAIT' ? 90 : 0; // as in Google's sample
    const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([sx, sy]) => {
      const x = (sx * pw) / 2;
      const y = (sy * plh) / 2;
      const a = Math.atan2(y, x) + orient * DEG;
      const r = Math.hypot(x, y);
      const along = r * Math.cos(a) * Math.cos(pitch * DEG); // the panel's slope length, seen from above
      const across = r * Math.sin(a);
      return { x: c.x + f.x * along + cdir.x * across, y: c.y + f.y * along + cdir.y * across };
    });
    if (!bySeg.has(p.segmentIndex)) bySeg.set(p.segmentIndex, { corners: [], count: 0, energy: 0 });
    const g = bySeg.get(p.segmentIndex);
    g.corners.push(...corners);
    g.count += 1;
    g.energy += p.yearlyEnergyDcKwh || 0;
  }
  const planes = [];
  for (const [i, g] of [...bySeg.entries()].sort((a, b) => b[1].energy - a[1].energy)) {
    const seg = segments[i];
    const outline = hull(g.corners);
    if (outline.length < 3) continue;
    const segCentre = seg.center ? toLocal({ lat: seg.center.latitude, lng: seg.center.longitude }, ref) : outline.reduce((s, p) => ({ x: s.x + p.x / outline.length, y: s.y + p.y / outline.length }), { x: 0, y: 0 });
    // the plane's height above the ground at its centre (Google gives it above sea level, like the
    // height map), then nudged onto the measured surface inside the face so panels sit on what is shown
    let height = seg.planeHeightAtCenterMeters != null && ground != null ? seg.planeHeightAtCenterMeters - ground : null;
    if (surf?.probe) {
      const az = (seg.azimuthDegrees ?? 180) * DEG;
      const tan = Math.tan((seg.pitchDegrees ?? 0) * DEG);
      const f = { x: Math.sin(az), y: Math.cos(az) };
      const offsets = [];
      surf.probe(outline, (p, h) => offsets.push(h + tan * ((p.x - segCentre.x) * f.x + (p.y - segCentre.y) * f.y))); // the surface height carried back to the centre
      if (offsets.length >= 8) height = percentile(offsets, 0.7); // a little above the middle: panels never sink into rough data
    }
    planes.push({
      id: `g${i}`,
      points: outline.map((p) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 })),
      pitch: Math.round((seg.pitchDegrees ?? 0) * 10) / 10,
      azimuth: Math.round((seg.azimuthDegrees ?? 180) * 10) / 10,
      height: height != null && height > 0.5 && height < 80 ? Math.round(height * 100) / 100 : null,
      centre: segCentre,
      googlePanels: g.count,
      yearlyEnergyDcKwh: Math.round(g.energy),
      sunshineHours: seg.stats?.sunshineQuantiles?.[5] ?? null,
    });
  }
  // a face without a measured height sits at the typical height of the others (or one storey)
  const known = planes.filter((p) => p.height != null).map((p) => p.height);
  const fallback = known.length ? percentile(known, 0.5) : 3;
  for (const p of planes) if (p.height == null) p.height = fallback;

  const result = {
    version: MODEL_VERSION,
    center: toLocal(center, ref),
    quality: insights.imageryQuality,
    imageryDate: insights.imageryDate,
    panel: { widthM: pw, heightM: plh, watts: sp.panelCapacityWatts || 400 },
    maxPanels: area ? panels.length : sp.maxArrayPanelsCount || panels.length,
    planes,
    house: surf?.house || null,
    houses: surf?.houses?.length ? surf.houses : surf?.house ? [surf.house] : [],
  };
  const at = Date.now();
  memory.set(key, { at, result });
  await table()?.updateOne({ _id: key }, { $set: { at, result } }, { upsert: true }).catch((err) => console.error('[solar-model] could not save:', err.message));
  return result;
}

export const _test = { hull };
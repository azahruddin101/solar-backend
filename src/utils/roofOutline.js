// Geometry for automatic roof detection: map projections, tracing a building in a raster mask,
// and tidying outlines (simplify, square the corners, snap parts together). Plain functions, no I/O.
//
// "Local metres" are x east / y north around a reference lat/lng (good to a few cm over a house).

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320;

/** lat/lng → local metres around `ref`. */
export const toLocal = (p, ref) => ({ x: (p.lng - ref.lng) * M_PER_DEG_LNG * Math.cos(ref.lat * DEG), y: (p.lat - ref.lat) * M_PER_DEG_LAT });
/** local metres around `ref` → lat/lng. */
export const toLatLng = (p, ref) => ({ lat: ref.lat + p.y / M_PER_DEG_LAT, lng: ref.lng + p.x / (M_PER_DEG_LNG * Math.cos(ref.lat * DEG)) });

// ---------- Web Mercator (Google Static Maps pixels) ----------

const TILE = 256;
const worldPx = (p, zoom) => {
  const s = Math.sin(p.lat * DEG);
  const n = TILE * 2 ** zoom;
  return { x: ((p.lng + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
};

/**
 * Converters between lat/lng and the pixels of a Static Maps image (centre, zoom, size in CSS pixels,
 * scale 1 or 2). The returned image is size × scale pixels; pixel (0, 0) is its top-left corner.
 */
export function staticMapFrame({ center, zoom, size, scale }) {
  const c = worldPx(center, zoom);
  const n = TILE * 2 ** zoom;
  const half = (size * scale) / 2;
  return {
    width: size * scale,
    height: size * scale,
    toPixel: (p) => {
      const w = worldPx(p, zoom);
      return { x: (w.x - c.x) * scale + half, y: (w.y - c.y) * scale + half };
    },
    toLatLng: (px) => {
      const wx = c.x + (px.x - half) / scale;
      const wy = c.y + (px.y - half) / scale;
      const lng = (wx / n) * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * wy) / n))) / DEG;
      return { lat, lng };
    },
  };
}

// ---------- UTM (Google Solar data layers are GeoTIFFs in UTM) ----------

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;

/** UTM zone/hemisphere from an EPSG code (326zz north, 327zz south), or null. */
export function utmZoneOf(epsg) {
  if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, south: false };
  if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, south: true };
  return null;
}

export function latLngToUtm({ lat, lng }, { zone, south }) {
  const lon0 = ((zone - 1) * 6 - 180 + 3) * DEG;
  const phi = lat * DEG;
  const n = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  const t = Math.tan(phi) ** 2;
  const c = EP2 * Math.cos(phi) ** 2;
  const a = Math.cos(phi) * (lng * DEG - lon0);
  const m = A * ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi - ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) + ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) - ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi));
  const x = K0 * n * (a + ((1 - t + c) * a ** 3) / 6 + ((5 - 18 * t + t ** 2 + 72 * c - 58 * EP2) * a ** 5) / 120) + 500000;
  let y = K0 * (m + n * Math.tan(phi) * (a ** 2 / 2 + ((5 - t + 9 * c + 4 * c ** 2) * a ** 4) / 24 + ((61 - 58 * t + t ** 2 + 600 * c - 330 * EP2) * a ** 6) / 720));
  if (south) y += 10000000;
  return { x, y };
}

export function utmToLatLng({ x, y }, { zone, south }) {
  const lon0 = ((zone - 1) * 6 - 180 + 3) * DEG;
  const m = (south ? y - 10000000 : y) / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const n1 = A / Math.sqrt(1 - E2 * Math.sin(phi1) ** 2);
  const t1 = Math.tan(phi1) ** 2;
  const c1 = EP2 * Math.cos(phi1) ** 2;
  const r1 = (A * (1 - E2)) / (1 - E2 * Math.sin(phi1) ** 2) ** 1.5;
  const d = (x - 500000) / (n1 * K0);
  const lat = phi1 - ((n1 * Math.tan(phi1)) / r1) * (d ** 2 / 2 - ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * EP2) * d ** 4) / 24 + ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * EP2 - 3 * c1 ** 2) * d ** 6) / 720);
  const lng = lon0 + (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * EP2 + 24 * t1 ** 2) * d ** 5) / 120) / Math.cos(phi1);
  return { lat: lat / DEG, lng: lng / DEG };
}

// ---------- raster mask → outline ----------

/**
 * The outline of the building under pixel (cx, cy) in a 0/1 mask (row-major, `width` × `height`),
 * as a ring of pixel-corner points, or null. If (cx, cy) is not on a roof, the nearest roof pixel
 * within `searchPx` is used. Holes (courtyards) are ignored: only the outer edge is returned.
 */
export function traceMaskOutline(mask, width, height, cx, cy, searchPx = 40) {
  const on = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] > 0;
  let sx = Math.round(cx);
  let sy = Math.round(cy);
  if (!on(sx, sy)) {
    let best = null;
    for (let r = 1; r <= searchPx && !best; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !on(sx + dx, sy + dy)) continue;
          const d = dx * dx + dy * dy;
          if (!best || d < best.d) best = { x: sx + dx, y: sy + dy, d };
        }
      }
    }
    if (!best) return null;
    sx = best.x;
    sy = best.y;
  }
  // the connected roof (4-neighbours)
  const comp = new Uint8Array(width * height);
  const stack = [sy * width + sx];
  comp[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % width;
    const y = (i - x) / width;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (!on(nx, ny)) continue;
      const j = ny * width + nx;
      if (!comp[j]) {
        comp[j] = 1;
        stack.push(j);
      }
    }
  }
  const outer = outlineOfComponent(comp, width, height);
  if (!outer) return null;
  outer.component = comp; // which pixels belong to this building (1) — for measuring it
  return outer;
}

/** Outer pixel-corner ring of a 0/1 component (holes ignored). */
export function outlineOfComponent(comp, width, height) {
  const inC = (x, y) => x >= 0 && y >= 0 && x < width && y < height && comp[y * width + x] === 1;
  const next = new Map();
  const key = (x, y) => `${x},${y}`;
  const add = (ax, ay, bx, by) => next.set(key(ax, ay), next.has(key(ax, ay)) ? [...next.get(key(ax, ay)), [bx, by]] : [[bx, by]]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inC(x, y)) continue;
      if (!inC(x, y - 1)) add(x + 1, y, x, y);
      if (!inC(x, y + 1)) add(x, y + 1, x + 1, y + 1);
      if (!inC(x - 1, y)) add(x, y, x, y + 1);
      if (!inC(x + 1, y)) add(x + 1, y + 1, x + 1, y);
    }
  }
  const rings = [];
  while (next.size) {
    const [startKey] = next.keys();
    const ring = [];
    let k = startKey;
    for (let guard = 0; guard < width * height * 4 && next.has(k); guard++) {
      const outs = next.get(k);
      const [nx, ny] = outs.pop();
      if (!outs.length) next.delete(k);
      const [x, y] = k.split(',').map(Number);
      ring.push({ x, y });
      k = key(nx, ny);
      if (k === startKey) break;
    }
    if (ring.length >= 4) rings.push(ring);
  }
  if (!rings.length) return null;
  const area = (r) => Math.abs(r.reduce((s, p, i) => s + p.x * r[(i + 1) % r.length].y - r[(i + 1) % r.length].x * p.y, 0)) / 2;
  return rings.reduce((m, r) => (area(r) > area(m) ? r : m));
}

/**
 * Separate buildings in a roof mask. A morphological opening of `radiusPx` breaks thin bridges
 * (touching neighbours, mask bleed across an alley); each remaining island is grown back onto the
 * original mask so walls are not shrunk. Components smaller than `minPx` are dropped.
 */
export function splitRoofComponents(mask, width, height, { radiusPx = 4, minPx = 80 } = {}) {
  const r = Math.max(1, radiusPx | 0);
  const r2 = r * r;
  const seeds = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      let ok = true;
      for (let dy = -r; dy <= r && ok; dy++) {
        for (let dx = -r; dx <= r && ok; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || !mask[ny * width + nx]) ok = false;
        }
      }
      if (ok) seeds[y * width + x] = 1;
    }
  }
  const label = new Int32Array(mask.length);
  let next = 0;
  for (let i = 0; i < seeds.length; i++) {
    if (!seeds[i] || label[i]) continue;
    next += 1;
    const stack = [i];
    label[i] = next;
    while (stack.length) {
      const k = stack.pop();
      const x = k % width;
      const y = (k - x) / width;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (!seeds[j] || label[j]) continue;
        label[j] = next;
        stack.push(j);
      }
    }
  }
  if (!next) return [];
  const restored = new Int32Array(mask.length);
  const queue = [];
  for (let i = 0; i < label.length; i++) {
    if (!label[i]) continue;
    restored[i] = label[i];
    queue.push(i);
  }
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q];
    const x = k % width;
    const y = (k - x) / width;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (restored[j] || !mask[j]) continue;
      restored[j] = restored[k];
      queue.push(j);
    }
  }
  const counts = new Int32Array(next + 1);
  for (let i = 0; i < restored.length; i++) if (restored[i]) counts[restored[i]] += 1;
  const keep = [];
  for (let id = 1; id <= next; id++) {
    if (counts[id] < minPx) continue;
    const comp = new Uint8Array(mask.length);
    for (let i = 0; i < restored.length; i++) if (restored[i] === id) comp[i] = 1;
    keep.push({ comp, n: counts[id] });
  }
  keep.sort((a, b) => b.n - a.n);
  return keep.map((k) => k.comp);
}

const percentile = (xs, q) => {
  if (!xs.length) return null;
  const a = Float64Array.from(xs).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
};

/**
 * Measure a building in a height raster (DSM, metres, same grid as its mask): how much of the roof is
 * flat, the typical pitch of the sloped part, and the eave height above the ground around it.
 * `comp` marks the building's pixels (1), `mask` all roofs (> 0), `res` is the pixel size (m).
 */
export function measureRoof(dsm, mask, comp, width, height, res) {
  const k = Math.max(1, Math.round(0.5 / res)); // compare heights 0.5 m apart: smooth enough, still sharp at ridges
  const at = (x, y) => dsm[y * width + x];
  const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height && comp[y * width + x] === 1;
  const slopes = [];
  const roofZ = [];
  const ground = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const z = dsm[i];
      if (!Number.isFinite(z) || z < -1000) continue;
      if (comp[i] !== 1) {
        if (!mask[i]) ground.push(z);
        continue;
      }
      roofZ.push(z);
      // sample a sparser grid for slopes, away from the roof's edge
      if (x % k || y % k || !inside(x - k, y) || !inside(x + k, y) || !inside(x, y - k) || !inside(x, y + k)) continue;
      const gx = (at(x + k, y) - at(x - k, y)) / (2 * k * res);
      const gy = (at(x, y + k) - at(x, y - k)) / (2 * k * res);
      slopes.push((Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI);
    }
  }
  if (slopes.length < 20 || roofZ.length < 50) return null;
  const sloped = slopes.filter((d) => d >= 8 && d <= 65);
  const flatShare = slopes.filter((d) => d < 8).length / slopes.length;
  // the ground: low part of the open land around (trees and other roofs are higher)
  const groundZ = percentile(ground, 0.2);
  const eaveZ = percentile(roofZ, 0.08);
  const ridgeZ = percentile(roofZ, 0.97);
  const eaveHeight = groundZ == null ? null : Math.max(0, eaveZ - groundZ);
  return {
    flatShare,
    pitch: sloped.length >= 10 ? percentile(sloped, 0.5) : null,
    eaveHeight,
    roofRise: ridgeZ - eaveZ,
    storeys: eaveHeight == null ? null : Math.min(5, Math.max(1, Math.round(eaveHeight / 3.1))),
  };
}

// ---------- tidying outlines (local metres) ----------

export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) a += pts[i].x * pts[(i + 1) % pts.length].y - pts[(i + 1) % pts.length].x * pts[i].y;
  return a / 2;
}
export const ensureCCW = (pts) => (signedArea(pts) < 0 ? [...pts].reverse() : pts);
export const centroid = (pts) => {
  const a = signedArea(pts);
  if (Math.abs(a) < 1e-9) return pts.reduce((s, p) => ({ x: s.x + p.x / pts.length, y: s.y + p.y / pts.length }), { x: 0, y: 0 });
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const c = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * c;
    cy += (p.y + q.y) * c;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
};

const segDist = (p, a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};

/** Douglas–Peucker on a closed ring. */
export function simplifyRing(pts, tol) {
  if (pts.length <= 4) return pts;
  // split at the two points farthest apart so the closed ring has fixed anchors
  const i0 = 0;
  let i1 = 0;
  let best = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (d > best) {
      best = d;
      i1 = i;
    }
  }
  const dp = (chain) => {
    if (chain.length <= 2) return chain;
    let idx = 0;
    let dmax = 0;
    for (let i = 1; i < chain.length - 1; i++) {
      const d = segDist(chain[i], chain[0], chain[chain.length - 1]);
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    if (dmax <= tol) return [chain[0], chain[chain.length - 1]];
    const left = dp(chain.slice(0, idx + 1));
    return [...left.slice(0, -1), ...dp(chain.slice(idx))];
  };
  const a = dp(pts.slice(i0, i1 + 1));
  const b = dp([...pts.slice(i1), pts[i0]]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Drop near-duplicate and almost-straight corners. */
export function cleanRing(pts, minLen = 0.3, minTurnDeg = 8) {
  let out = pts.filter((p, i) => Math.hypot(p.x - pts[(i + 1) % pts.length].x, p.y - pts[(i + 1) % pts.length].y) > minLen * 0.5);
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const turn = Math.abs(Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y))) / DEG;
      const short = Math.hypot(c.x - b.x, c.y - b.y) < minLen;
      if (turn < minTurnDeg || (short && out.length > 4 && Math.hypot(b.x - a.x, b.y - a.y) < minLen)) {
        out = out.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Main direction of an outline (radians, 0..π/2): length-weighted average of its edges, modulo 90°. */
export function dominantAngle(pts) {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    sx += len * Math.cos(4 * ang);
    sy += len * Math.sin(4 * ang);
  }
  return Math.atan2(sy, sx) / 4;
}

/**
 * Square the corners: every edge within `tolDeg` of the main direction (or across it) becomes exactly
 * parallel / perpendicular; new corners are where those lines meet. Edges further off stay as drawn.
 * `angle` lets several parts share one direction.
 */
export function squareUp(pts, tolDeg = 18, angle = dominantAngle(pts), minStep = 0.9) {
  if (pts.length < 4) return pts;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rot = (p) => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos });
  const unrot = (p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos });
  const loc = pts.map(rot);
  const n = loc.length;
  // each edge as a line: horizontal (y = c), vertical (x = c) or free (through its two points)
  let lines = [];
  for (let i = 0; i < n; i++) {
    const a = loc[i];
    const b = loc[(i + 1) % n];
    const ang = (Math.atan2(b.y - a.y, b.x - a.x) / DEG + 360) % 180;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (Math.min(ang, 180 - ang) <= tolDeg) lines.push({ kind: 'h', c: (a.y + b.y) / 2, w: len });
    else if (Math.abs(ang - 90) <= tolDeg) lines.push({ kind: 'v', c: (a.x + b.x) / 2, w: len });
    else lines.push({ kind: 'f', a, b, w: len });
  }
  // small steps and cut corners (under `minStep`) between two walls are dropped, then neighbours of
  // the same kind merge (a staircase run becomes one wall)
  for (let pass = 0; pass < 3 && lines.length > 4; pass++) {
    const k = lines.length;
    const drop = lines.map((l, i) => {
      if (l.w >= minStep) return false;
      const prev = lines[(i - 1 + k) % k];
      const nxt = lines[(i + 1) % k];
      return prev.kind !== 'f' && nxt.kind !== 'f' && (prev.kind === nxt.kind || l.kind === 'f');
    });
    if (!drop.some(Boolean)) break;
    lines = lines.filter((_, i) => !drop[i]);
  }
  const merged = [];
  for (const l of lines) {
    const last = merged[merged.length - 1];
    if (last && l.kind !== 'f' && last.kind === l.kind) {
      last.c = (last.c * last.w + l.c * l.w) / (last.w + l.w);
      last.w += l.w;
    } else merged.push({ ...l });
  }
  if (merged.length > 1 && merged[0].kind !== 'f' && merged[0].kind === merged[merged.length - 1].kind) {
    const l = merged.pop();
    merged[0].c = (merged[0].c * merged[0].w + l.c * l.w) / (merged[0].w + l.w);
    merged[0].w += l.w;
  }
  lines = merged;
  if (lines.length < 3) return pts;
  const meet = (l1, l2) => {
    const asLine = (l) => (l.kind === 'h' ? { p: { x: 0, y: l.c }, d: { x: 1, y: 0 } } : l.kind === 'v' ? { p: { x: l.c, y: 0 }, d: { x: 0, y: 1 } } : { p: l.a, d: { x: l.b.x - l.a.x, y: l.b.y - l.a.y } });
    const A1 = asLine(l1);
    const A2 = asLine(l2);
    const den = A1.d.x * A2.d.y - A1.d.y * A2.d.x;
    if (Math.abs(den) < 1e-9) return null; // parallel neighbours (a tiny jog): no corner
    const t = ((A2.p.x - A1.p.x) * A2.d.y - (A2.p.y - A1.p.y) * A2.d.x) / den;
    return { x: A1.p.x + A1.d.x * t, y: A1.p.y + A1.d.y * t };
  };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const p = meet(lines[(i - 1 + lines.length) % lines.length], lines[i]);
    if (p) out.push(unrot(p));
  }
  if (out.length < 3) return pts;
  // a sanity check: squaring must not change the area much
  const before = Math.abs(signedArea(pts));
  const after = Math.abs(signedArea(out));
  return after > before * 0.75 && after < before * 1.25 ? ensureCCW(out) : pts;
}

/** Move corners of `pts` onto nearby corners of `targets` (within `tol` metres). */
export function snapCorners(pts, targets, tol = 0.8) {
  return pts.map((p) => {
    let best = null;
    let d = tol;
    for (const t of targets) {
      const e = Math.hypot(t.x - p.x, t.y - p.y);
      if (e < d) {
        d = e;
        best = t;
      }
    }
    return best ? { ...best } : p;
  });
}

export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * `base` minus the `cuts`, for square-cornered outlines that share one direction (`angle`, radians).
 * Works on the grid of all their wall lines, so the result is exact and stays square. Returns the
 * largest remaining piece (CCW), or `base` when nothing sensible is left.
 */
export function squareSubtract(base, cuts, angle) {
  if (!cuts.length) return base;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rot = (p) => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos });
  const unrot = (p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos });
  const B = base.map(rot);
  const C = cuts.map((c) => c.map(rot));
  const uniq = (xs) => xs.sort((p, q) => p - q).filter((x, i, arr) => i === 0 || x - arr[i - 1] > 0.05);
  const us = uniq([...B, ...C.flat()].map((p) => p.x));
  const vs = uniq([...B, ...C.flat()].map((p) => p.y));
  const I = us.length - 1;
  const J = vs.length - 1;
  if (I < 1 || J < 1 || I * J > 40000) return base;
  const cells = new Uint8Array(I * J);
  let best = -1;
  let bestArea = 0;
  for (let j = 0; j < J; j++) {
    for (let i = 0; i < I; i++) {
      const m = { x: (us[i] + us[i + 1]) / 2, y: (vs[j] + vs[j + 1]) / 2 };
      if (pointInPolygon(m, B) && !C.some((c) => pointInPolygon(m, c))) {
        cells[j * I + i] = 1;
        const a = (us[i + 1] - us[i]) * (vs[j + 1] - vs[j]);
        if (a > bestArea) {
          bestArea = a;
          best = j * I + i;
        }
      }
    }
  }
  if (best < 0) return base;
  // trace on the cell grid (rows = j), then map grid corners back to metres
  const ring = traceMaskOutline(cells, I, J, best % I, Math.floor(best / I), 0);
  if (!ring) return base;
  const out = cleanRing(ring.map((p) => unrot({ x: us[p.x], y: vs[p.y] })), 0.05, 1);
  return out.length >= 3 && Math.abs(signedArea(out)) > Math.abs(signedArea(base)) * 0.3 ? ensureCCW(out) : base;
}

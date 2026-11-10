import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanRing, latLngToUtm, signedArea, simplifyRing, splitRoofComponents, squareUp, staticMapFrame, traceMaskOutline, utmToLatLng, utmZoneOf } from '../src/utils/roofOutline.js';

test('traces an L-shaped building in a mask and squares it up', () => {
  const W = 300;
  const H = 300;
  const mask = new Uint8Array(W * H);
  const rot = (20 * Math.PI) / 180;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x - 150) * Math.cos(rot) + (y - 150) * Math.sin(rot);
      const v = -(x - 150) * Math.sin(rot) + (y - 150) * Math.cos(rot);
      if ((u > -60 && u < 60 && v > -40 && v < 10) || (u > 20 && u < 60 && v > -40 && v < 60)) mask[y * W + x] = 1;
    }
  }
  for (let y = 10; y < 40; y++) for (let x = 10; x < 60; x++) mask[y * W + x] = 1; // a neighbour, not traced
  const ring = traceMaskOutline(mask, W, H, 150, 150);
  const metres = ring.map((p) => ({ x: p.x * 0.1, y: -p.y * 0.1 }));
  const out = squareUp(cleanRing(simplifyRing(metres, 0.45)));
  assert.equal(out.length, 6);
  assert.ok(Math.abs(Math.abs(signedArea(out)) - 80) < 1.5, `area ${signedArea(out)}`);
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    const b = out[(i + 1) % out.length];
    const ang = ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 90;
    assert.ok(Math.abs(ang - 70) < 1, `edge ${i} at ${ang}°`); // every wall at 20° (or across it)
  }
});

test('splits two nearby buildings joined by a thin mask bridge', () => {
  const W = 80;
  const H = 40;
  const mask = new Uint8Array(W * H);
  for (let y = 5; y < 35; y++) {
    for (let x = 5; x < 35; x++) mask[y * W + x] = 1;
    for (let x = 45; x < 75; x++) mask[y * W + x] = 1;
  }
  for (let y = 19; y < 22; y++) for (let x = 35; x < 45; x++) mask[y * W + x] = 1; // 3-pixel-wide alley fill
  const comps = splitRoofComponents(mask, W, H, { radiusPx: 3, minPx: 50 });
  assert.equal(comps.length, 2);
});

test('keeps one L-shaped building as a single component', () => {
  const W = 80;
  const H = 80;
  const mask = new Uint8Array(W * H);
  for (let y = 10; y < 40; y++) for (let x = 10; x < 70; x++) mask[y * W + x] = 1;
  for (let y = 40; y < 70; y++) for (let x = 10; x < 40; x++) mask[y * W + x] = 1;
  const comps = splitRoofComponents(mask, W, H, { radiusPx: 3, minPx: 50 });
  assert.equal(comps.length, 1);
});

test('finds the nearest roof when the pin is just off it', () => {
  const W = 100;
  const mask = new Uint8Array(W * W);
  for (let y = 40; y < 60; y++) for (let x = 50; x < 80; x++) mask[y * W + x] = 1;
  assert.ok(traceMaskOutline(mask, W, W, 45, 50, 10));
  assert.equal(traceMaskOutline(mask, W, W, 10, 10, 10), null);
});

test('drops small steps when squaring', () => {
  // 10 × 6 rectangle with a 0.4 m jog on the top wall
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 5, y: 6 }, { x: 5, y: 6.4 }, { x: 0, y: 6.4 }];
  assert.equal(squareUp(pts).length, 4);
});

test('UTM and Static Maps pixel conversions round-trip', () => {
  const zone = utmZoneOf(32643);
  const p = { lat: 9.9312, lng: 76.2673 };
  const back = utmToLatLng(latLngToUtm(p, zone), zone);
  assert.ok(Math.hypot(back.lat - p.lat, back.lng - p.lng) * 111000 < 0.01);
  const frame = staticMapFrame({ center: p, zoom: 20, size: 640, scale: 2 });
  const q = { lat: 9.93125, lng: 76.26735 };
  const ll = frame.toLatLng(frame.toPixel(q));
  assert.ok(Math.hypot(ll.lat - q.lat, ll.lng - q.lng) * 111000 < 0.01);
  assert.deepEqual(frame.toPixel(p), { x: 640, y: 640 });
});

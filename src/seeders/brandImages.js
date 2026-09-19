// Draws sample branding images for a demo company: a logo, a handwritten-style signature and a
// real QR code that opens the company's website.
import QRCode from 'qrcode';
import { Canvas } from '../utils/png.js';

/** Wide logo on a transparent background: sun rising behind a tilted solar panel, plus a wordmark of bars. */
export function drawLogo({ primary, accent }) {
  const c = new Canvas(520, 160);
  c.circle(80, 84, 46, accent);
  for (let i = 0; i < 9; i++) {
    const a = Math.PI + (i * Math.PI) / 8;
    c.line(80 + Math.cos(a) * 56, 84 + Math.sin(a) * 56, 80 + Math.cos(a) * 72, 84 + Math.sin(a) * 72, 7, accent);
  }
  c.roundRect(20, 86, 150, 58, 10, primary); // the panel covers the lower half of the sun
  for (let i = 1; i < 4; i++) c.line(20 + i * 37.5, 92, 20 + i * 37.5, 138, 3, '#ffffff');
  c.line(28, 115, 162, 115, 3, '#ffffff');
  // abstract wordmark
  c.roundRect(200, 42, 290, 26, 13, primary);
  c.roundRect(200, 84, 200, 18, 9, primary);
  c.roundRect(412, 84, 78, 18, 9, accent);
  c.roundRect(200, 116, 120, 12, 6, '#94a3b8');
  return c.toPNG();
}

/** A flowing pen stroke that reads as a signature; seeded by the name so each company differs. */
export function drawSignature(name) {
  const c = new Canvas(460, 150);
  let seed = [...name].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const loops = 5 + Math.floor(rnd() * 3);
  const pts = [];
  for (let i = 0; i <= 260; i++) {
    const t = i / 260;
    const x = 30 + t * 380 + Math.sin(t * Math.PI * loops * 2) * (14 + rnd() * 1.5);
    const envelope = 34 * (1 - t * 0.55);
    const y = 82 - Math.sin(t * Math.PI * loops * 2 + 0.6) * envelope * (i < 40 ? 1.5 : 1) + t * 10;
    pts.push([x, y, 2.2 + Math.abs(Math.cos(t * Math.PI * loops * 2)) * 2.2]);
  }
  c.stroke(pts, '#1e293b');
  c.stroke(Array.from({ length: 40 }, (_, i) => [50 + i * 9.4, 126 - Math.sin((i / 39) * Math.PI) * 7, 2.6 - i * 0.03]), '#1e293b'); // underline flourish
  return c.toPNG();
}

export const drawQr = (text) => QRCode.toBuffer(text, { type: 'png', width: 480, margin: 2, errorCorrectionLevel: 'M' });

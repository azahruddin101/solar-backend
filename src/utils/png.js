// Minimal RGBA canvas + PNG encoder (no native deps). Used by the seeders to draw sample logos
// and signatures.
import zlib from 'node:zlib';

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

export class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4); // transparent
  }

  /** Blend one pixel; `alpha` 0–1 gives soft (anti-aliased) edges. */
  plot(x, y, [r, g, b], alpha = 1) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || alpha <= 0) return;
    const i = (y * this.width + x) * 4;
    const a = Math.min(1, alpha);
    const under = this.data[i + 3] / 255;
    const out = a + under * (1 - a);
    for (let c = 0; c < 3; c++) this.data[i + c] = Math.round(([r, g, b][c] * a + this.data[i + c] * under * (1 - a)) / out);
    this.data[i + 3] = Math.round(out * 255);
  }

  /** Fill every pixel whose signed distance (px, negative = inside) to the shape is < 0. */
  fill(distance, hex, box = [0, 0, this.width, this.height]) {
    const rgb = hexToRgb(hex);
    for (let y = Math.max(0, Math.floor(box[1])); y < Math.min(this.height, Math.ceil(box[3])); y++)
      for (let x = Math.max(0, Math.floor(box[0])); x < Math.min(this.width, Math.ceil(box[2])); x++) this.plot(x, y, rgb, 0.5 - distance(x + 0.5, y + 0.5));
  }

  circle(cx, cy, r, hex) {
    this.fill((x, y) => Math.hypot(x - cx, y - cy) - r, hex, [cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1]);
  }

  roundRect(x0, y0, w, h, radius, hex) {
    const cx = x0 + w / 2;
    const cy = y0 + h / 2;
    this.fill((x, y) => {
      const dx = Math.abs(x - cx) - (w / 2 - radius);
      const dy = Math.abs(y - cy) - (h / 2 - radius);
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
    }, hex, [x0 - 1, y0 - 1, x0 + w + 1, y0 + h + 1]);
  }

  /** Round-capped line segment. */
  line(ax, ay, bx, by, thickness, hex) {
    const r = thickness / 2;
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
    this.fill((x, y) => {
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
      return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) - r;
    }, hex, [Math.min(ax, bx) - r - 1, Math.min(ay, by) - r - 1, Math.max(ax, bx) + r + 1, Math.max(ay, by) + r + 1]);
  }

  /** Smooth stroke through `points` ([x, y, thickness]) — used for handwriting. */
  stroke(points, hex) {
    for (let i = 1; i < points.length; i++) this.line(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], (points[i - 1][2] + points[i][2]) / 2, hex);
  }

  toPNG() {
    const chunk = (type, body) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write(type, 4, 'latin1');
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])), 0);
      return Buffer.concat([head, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
    const stride = this.width * 4;
    const raw = Buffer.alloc((stride + 1) * this.height); // each row is prefixed with filter type 0
    for (let y = 0; y < this.height; y++) raw.set(this.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  }
}

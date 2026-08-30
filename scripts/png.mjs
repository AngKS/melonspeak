// Minimal RGBA PNG writer and a scratch canvas, with no dependencies.
//
// Shared by icons.mjs (the icons shipped inside the extension) and
// store-assets.mjs (the listing imagery). Keeping one encoder means the store
// tile and the installed icon are drawn by the same code and cannot drift.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** 8-bit RGBA PNG. `rgba` is width*height*4 bytes, row-major. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  // Each scanline is prefixed with its filter byte (0 = none).
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Transparent RGBA canvas. */
export function createCanvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

/** Flood the canvas with an opaque colour. */
export function fill(canvas, [r, g, b]) {
  for (let i = 0; i < canvas.data.length; i += 4) {
    canvas.data[i] = r;
    canvas.data[i + 1] = g;
    canvas.data[i + 2] = b;
    canvas.data[i + 3] = 255;
  }
}

/**
 * Source-over compositing of one pixel.
 *
 * Straight (non-premultiplied) alpha, because that is what the PNG encoder
 * above writes and what browsers expect from an extension icon; compositing
 * onto a transparent pixel therefore has to recover the destination colour
 * rather than just blending toward black, or every antialiased edge on a
 * transparent background picks up a dark fringe.
 */
export function blend(canvas, x, y, [r, g, b], alpha) {
  if (alpha <= 0.004 || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const o = (y * canvas.width + x) * 4;
  const dstA = canvas.data[o + 3] / 255;
  if (dstA === 0) {
    // Nothing underneath: write the colour straight through. Not just faster —
    // the general path divides by outA to un-premultiply, and that round trip
    // shifts a value like 200.5 to 200.4999… , changing the rounded byte.
    canvas.data[o] = Math.round(r);
    canvas.data[o + 1] = Math.round(g);
    canvas.data[o + 2] = Math.round(b);
    canvas.data[o + 3] = Math.round(alpha * 255);
    return;
  }
  const outA = alpha + dstA * (1 - alpha);
  if (outA <= 0) return;
  canvas.data[o] = Math.round((r * alpha + canvas.data[o] * dstA * (1 - alpha)) / outA);
  canvas.data[o + 1] = Math.round((g * alpha + canvas.data[o + 1] * dstA * (1 - alpha)) / outA);
  canvas.data[o + 2] = Math.round((b * alpha + canvas.data[o + 2] * dstA * (1 - alpha)) / outA);
  canvas.data[o + 3] = Math.round(outA * 255);
}

/** Antialiased axis-aligned rounded rectangle, used for the waveform bars. */
export function roundedRect(canvas, x0, y0, w, h, radius, color, alpha = 1) {
  const r = Math.min(radius, w / 2, h / 2);
  const cx0 = x0 + r;
  const cx1 = x0 + w - r;
  const cy0 = y0 + r;
  const cy1 = y0 + h - r;
  for (let y = Math.floor(y0) - 1; y <= Math.ceil(y0 + h) + 1; y++) {
    for (let x = Math.floor(x0) - 1; x <= Math.ceil(x0 + w) + 1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // Distance outside the rounded rect: 0 inside, growing beyond the edge.
      const dx = Math.max(cx0 - px, 0, px - cx1);
      const dy = Math.max(cy0 - py, 0, py - cy1);
      const d = Math.hypot(dx, dy) - r;
      blend(canvas, x, y, color, alpha * (1 - smoothstep(-0.7, 0.7, d)));
    }
  }
}

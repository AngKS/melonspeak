// Generates the MelonSpeak icon (a watermelon slice) as PNGs, no dependencies.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

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

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// Watermelon slice, flat side up, on transparent background.
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size * 0.3;
  const R = size * 0.46;
  const aa = Math.max(0.8, size / 64); // antialias width in px
  const FLESH = [255, 92, 110];
  const WHITE = [247, 250, 240];
  const RIND = [42, 140, 74];
  const SEED = [40, 30, 34];
  const seeds =
    size >= 32
      ? [255, 270, 285].map((deg) => {
          const a = (deg * Math.PI) / 180;
          return [cx + Math.cos(a) * R * 0.45, cy - Math.sin(a) * R * 0.45];
        })
      : [];
  const seedR = R * 0.075;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const r = Math.hypot(px - cx, py - cy);
      // Coverage: inside circle AND below the flat top edge.
      const alpha =
        (1 - smoothstep(R - aa, R + aa, r)) * smoothstep(cy - aa, cy + aa, py);
      if (alpha <= 0.004) continue;
      let color;
      if (r <= R * 0.76) color = FLESH;
      else if (r <= R * 0.84) color = WHITE;
      else color = RIND;
      // Blend band edges for smoothness.
      if (r > R * 0.76 - aa && r < R * 0.76 + aa) {
        const t = smoothstep(R * 0.76 - aa, R * 0.76 + aa, r);
        color = FLESH.map((c, i) => c + (WHITE[i] - c) * t);
      } else if (r > R * 0.84 - aa && r < R * 0.84 + aa) {
        const t = smoothstep(R * 0.84 - aa, R * 0.84 + aa, r);
        color = WHITE.map((c, i) => c + (RIND[i] - c) * t);
      }
      for (const [sx, sy] of seeds) {
        const sd = Math.hypot(px - sx, py - sy);
        if (sd < seedR + aa && r <= R * 0.7) {
          const t = 1 - smoothstep(seedR - aa, seedR + aa, sd);
          color = color.map((c, i) => c + (SEED[i] - c) * t);
        }
      }
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(color[0]);
      rgba[o + 1] = Math.round(color[1]);
      rgba[o + 2] = Math.round(color[2]);
      rgba[o + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

mkdirSync('src/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(`src/icons/icon${size}.png`, encodePng(size, drawIcon(size)));
}
console.log('icons written to src/icons/');

// Generates the Chrome Web Store / AMO listing imagery into docs/store/assets/.
//
// These are listing assets, not shipped files — nothing here goes into the
// extension package. They are generated rather than hand-drawn so the mark on
// the tile is provably the same mark the extension installs (both call
// drawMelon), and so a palette change lands everywhere at once.
//
//   store-icon-128.png     128x128, 96x96 of artwork with 16px transparent
//                          padding, per Chrome's icon spec
//   promo-tile-440x280.png the small promo tile; a listing without one is
//                          ranked below listings that have one
//   promo-marquee-1400x560.png  optional, required to be eligible for
//                          marquee featuring
//
// Run: node scripts/store-assets.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas, encodePng, fill, roundedRect } from './png.mjs';
import { drawMelon, MELON, PANEL_BG, RIND_CSS } from './melon.mjs';
import { drawText, measureText } from './glyphs.mjs';

const OUT = 'docs/store/assets';
const CREAM = [247, 250, 240];

/** Mixes two colours, t=0 → a, t=1 → b. */
const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);

/**
 * The visualizer motif: bars rising and falling around a centre line, the
 * same log-spaced speech-band shape the Now Reading view draws. Deterministic,
 * so regenerating the assets never silently changes them.
 */
function waveform(canvas, x, centerY, width, maxHeight, bars, opts = {}) {
  const { gapRatio = 0.4, alpha = 1 } = opts;
  const pitch = width / bars;
  const barW = pitch * (1 - gapRatio);
  for (let i = 0; i < bars; i++) {
    const t = i / (bars - 1);
    // Envelope: energy rises quickly, peaks left of centre where speech lives,
    // then tails off — the shape the panel's own log-spaced bars make.
    const env = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 0.85);
    // Detail: two incommensurate sinusoids so adjacent bars differ and it
    // reads as a spectrum rather than a smooth hill. Kept shallow — deeper
    // modulation carves a notch through the middle and the ramp stops looking
    // like one signal. Deterministic, so regenerating never quietly changes it.
    const detail = 0.2 * Math.sin(11.2 * t + 0.7) + 0.12 * Math.sin(19.7 * t + 2.1);
    // Floor of 0.28: below that the tail bars shrink to dots and the band
    // reads as a dashed line instead of a decaying spectrum.
    const h = maxHeight * Math.min(1, Math.max(0.28, env * (0.8 + detail)));
    // Melon at the low end fading to rind green at the high end, matching the
    // visualizer's own colour ramp.
    const color = mix(MELON, RIND_CSS, Math.pow(t, 1.25));
    roundedRect(canvas, x + i * pitch, centerY - h / 2, barW, h, barW / 2, color, alpha);
  }
}

// --- store icon -----------------------------------------------------------
// Chrome asks for 96x96 of artwork inside a 128x128 canvas, the remaining
// 16px on every side transparent, so the store's own framing has room.

function storeIcon() {
  const S = 128;
  const ART = 96;
  const canvas = createCanvas(S, S);
  const R = ART / 2; // the dome spans the full 96px artwork width
  // A dome is 2R wide and R tall, so centring it vertically in the artwork box
  // puts its flat top R/2 above the centre.
  drawMelon(canvas, S / 2, S / 2 - R / 2, R, { seeds: true, aa: 1.5 });
  return encodePng(S, S, canvas.data);
}

// --- promo tiles ----------------------------------------------------------

/**
 * One layout, two sizes. The small tile stacks the lockup over the waveform;
 * the marquee, being 2.5:1, sets the lockup left and lets the waveform run
 * across the right where there is room for it to breathe.
 */
function promoTile(W, H, { horizontal }) {
  const canvas = createCanvas(W, H);
  fill(canvas, PANEL_BG);

  // A very soft melon wash behind the lockup, so the near-black ground has some
  // depth at thumbnail size instead of reading as a flat rectangle. Wide and
  // weak on purpose — a tighter, stronger one reads as a visible disc.
  const glowX = horizontal ? W * 0.34 : W / 2;
  const glowY = horizontal ? H * 0.5 : H * 0.4;
  const glowR = Math.max(W, H) * (horizontal ? 0.55 : 0.62);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x + 0.5 - glowX, y + 0.5 - glowY) / glowR;
      if (d >= 1) continue;
      const a = Math.pow(1 - d, 2.6) * 0.11;
      const o = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) {
        canvas.data[o + k] = Math.round(canvas.data[o + k] + (MELON[k] - canvas.data[o + k]) * a);
      }
    }
  }

  if (horizontal) {
    // Marquee is 2.5:1 — far too wide to stack. Mark and wordmark sit side by
    // side on the left as one lockup, sharing a centre line, and the waveform
    // runs out to the right where it has room.
    const cap = H * 0.105;
    const wordW = measureText('MelonSpeak') * cap;
    const midY = H * 0.5;
    const R = H * 0.23;
    const markX = W * 0.05 + R;
    // A dome's visual centre is R/2 below its flat top.
    drawMelon(canvas, markX, midY - R / 2, R, { seeds: true, aa: R / 30 });
    drawText(canvas, 'MelonSpeak', markX + R + W * 0.022, midY + cap / 2, cap, CREAM);
    const waveX = markX + R + W * 0.022 + wordW + W * 0.035;
    waveform(canvas, waveX, midY, W * 0.95 - waveX, H * 0.62, 20);
  } else {
    // Small tile: centred lockup, waveform as a band along the bottom.
    const cap = H * 0.105;
    const wordW = measureText('MelonSpeak') * cap;
    const R = H * 0.245;
    const markTop = H * 0.14;
    drawMelon(canvas, W / 2, markTop, R, { seeds: true, aa: R / 30 });
    drawText(canvas, 'MelonSpeak', (W - wordW) / 2, markTop + R + H * 0.185, cap, CREAM);
    waveform(canvas, W * 0.15, H * 0.82, W * 0.7, H * 0.2, 18);
  }
  return encodePng(W, H, canvas.data);
}

mkdirSync(OUT, { recursive: true });
const assets = [
  ['store-icon-128.png', storeIcon()],
  ['promo-tile-440x280.png', promoTile(440, 280, { horizontal: false })],
  ['promo-marquee-1400x560.png', promoTile(1400, 560, { horizontal: true })],
];
for (const [name, buf] of assets) {
  writeFileSync(`${OUT}/${name}`, buf);
  console.log(`  ${name.padEnd(30)} ${(buf.length / 1024).toFixed(1)} KB`);
}
console.log(`\nstore assets written to ${OUT}/`);

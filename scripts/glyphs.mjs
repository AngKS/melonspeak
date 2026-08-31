// A minimal geometric sans, just wide enough to set the word "MelonSpeak".
//
// The generator has no font and no font library, so each letter is described
// as stroked paths — line segments and circular arcs — and rasterized from
// their signed distance. Round caps and a single stroke weight throughout give
// it a Futura-ish geometric feel that suits the round mark.
//
// Coordinate space, per glyph: x grows right from the glyph origin, y grows UP
// from the baseline. Cap height is 1, x-height 0.72, descender -0.28. The
// caller scales and flips into pixel space.
import { blend, smoothstep } from './png.mjs';

const X_HEIGHT = 0.72;
const BOWL = X_HEIGHT / 2; // radius of a lowercase bowl
const DEG = Math.PI / 180;
const WEIGHT = 0.13; // stroke width, in cap-height units

/**
 * Sidebearing: the space between a glyph's stroke EDGE and its advance box,
 * per side. Every glyph below defines its ink starting at x=0 and declares the
 * width of its centreline extent; the advance is derived, so no letter can end
 * up with ink flush against its own edge.
 *
 * This is not cosmetic. With ink flush to the box, 'a' (whose stem sits at the
 * far right) followed by 'k' (whose stem sits at the far left) put two
 * full-weight verticals a hair apart, and "Speak" rendered as "Speok".
 */
const SIDEBEARING = 0.05;
const pad = WEIGHT / 2 + SIDEBEARING;

/** line: ['l', x0, y0, x1, y1]   arc: ['a', cx, cy, r, startDeg, endDeg] */
const RAW = {
  // width = extent of the centreline paths; advance is width + 2*pad.
  M: {
    width: 0.92,
    paths: [
      ['l', 0, 0, 0, 1],
      ['l', 0, 1, 0.46, 0.32],
      ['l', 0.46, 0.32, 0.92, 1],
      ['l', 0.92, 1, 0.92, 0],
    ],
  },
  e: {
    width: X_HEIGHT,
    paths: [
      // Bowl left open at the lower right, plus the crossbar.
      ['a', BOWL, BOWL, BOWL, 0, 305],
      ['l', 0.02, BOWL, X_HEIGHT - 0.02, BOWL],
    ],
  },
  l: { width: 0, paths: [['l', 0, 0, 0, 1]] },
  o: { width: X_HEIGHT, paths: [['a', BOWL, BOWL, BOWL, 0, 360]] },
  n: {
    width: X_HEIGHT,
    paths: [
      ['l', 0, 0, 0, X_HEIGHT],
      ['a', BOWL, BOWL, BOWL, 0, 180], // the shoulder
      ['l', X_HEIGHT, 0, X_HEIGHT, BOWL],
    ],
  },
  S: {
    // Two bowls of radius r, tangent at mid-cap. Cap height 1 forces r = 0.25
    // (upper centre at 1-r, lower at r, meeting where 1-2r = 0.5), which is
    // why a geometric S is narrower than an o — as it should be.
    width: 0.5,
    paths: [
      ['a', 0.25, 0.75, 0.25, 30, 270],
      ['a', 0.25, 0.25, 0.25, -150, 90],
    ],
  },
  p: {
    width: X_HEIGHT,
    paths: [
      ['l', 0, -0.28, 0, X_HEIGHT],
      ['a', BOWL, BOWL, BOWL, 0, 360],
    ],
  },
  a: {
    width: X_HEIGHT,
    // Single-storey: a circle with a stem on the right.
    paths: [
      ['a', BOWL, BOWL, BOWL, 0, 360],
      ['l', X_HEIGHT, 0, X_HEIGHT, X_HEIGHT],
    ],
  },
  k: {
    width: 0.6,
    paths: [
      ['l', 0, 0, 0, 1],
      ['l', 0.58, X_HEIGHT, 0.03, 0.26],
      ['l', 0.20, 0.40, 0.60, 0],
    ],
  },
};

const GLYPHS = Object.fromEntries(
  Object.entries(RAW).map(([ch, g]) => [ch, { ...g, advance: g.width + 2 * pad, lsb: pad }]),
);

/** Distance from p to a line segment. */
function distSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/**
 * Distance from p to a circular arc spanning [a0, a1] degrees, measured CCW.
 * Outside that span the nearest point is one of the two endpoints, which is
 * what gives the stroke its round caps.
 */
function distArc(px, py, cx, cy, r, a0, a1) {
  const dx = px - cx;
  const dy = py - cy;
  let theta = (Math.atan2(dy, dx) / DEG - a0) % 360;
  if (theta < 0) theta += 360;
  if (theta <= a1 - a0) return Math.abs(Math.hypot(dx, dy) - r);
  const p0 = [cx + r * Math.cos(a0 * DEG), cy + r * Math.sin(a0 * DEG)];
  const p1 = [cx + r * Math.cos(a1 * DEG), cy + r * Math.sin(a1 * DEG)];
  return Math.min(Math.hypot(px - p0[0], py - p0[1]), Math.hypot(px - p1[0], py - p1[1]));
}

/** Total advance width of `text`, in cap-height units. */
export function measureText(text, tracking = 0.03) {
  let w = 0;
  for (const ch of text) {
    if (ch === ' ') {
      w += 0.3 + tracking;
      continue;
    }
    w += GLYPHS[ch].advance + tracking;
  }
  return w - tracking;
}

/**
 * Draws `text` onto the canvas.
 *
 * `x`/`baselineY` are in pixels, `cap` is the cap height in pixels, and the
 * glyph space is flipped so y grows up from the baseline as the definitions
 * above assume.
 */
export function drawText(canvas, text, x, baselineY, cap, color, opts = {}) {
  const { weight = WEIGHT, tracking = 0.03, alpha = 1 } = opts;
  const hw = (weight * cap) / 2; // half stroke width, in pixels
  const aa = 0.7;

  let penX = x;
  for (const ch of text) {
    if (ch === ' ') {
      penX += (0.3 + tracking) * cap;
      continue;
    }
    const glyph = GLYPHS[ch];
    if (!glyph) throw new Error(`glyphs.mjs has no definition for ${JSON.stringify(ch)}`);

    // Ink origin sits one sidebearing in from the advance box.
    const inkX = penX + glyph.lsb * cap;
    // Bounding box in pixels, padded for the stroke and its antialiasing.
    const bpad = hw + aa + 2;
    const x0 = Math.floor(inkX - bpad);
    const x1 = Math.ceil(inkX + glyph.width * cap + bpad);
    const y0 = Math.floor(baselineY - cap - bpad);
    const y1 = Math.ceil(baselineY + 0.28 * cap + bpad);

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        // Into glyph space: origin at the pen, y up, scaled to cap height.
        const gx = (px + 0.5 - inkX) / cap;
        const gy = (baselineY - (py + 0.5)) / cap;
        let d = Infinity;
        for (const path of glyph.paths) {
          d = Math.min(
            d,
            path[0] === 'l'
              ? distSegment(gx, gy, path[1], path[2], path[3], path[4])
              : distArc(gx, gy, path[1], path[2], path[3], path[4], path[5]),
          );
        }
        const cov = 1 - smoothstep(hw - aa, hw + aa, d * cap);
        if (cov > 0) blend(canvas, px, py, color, cov * alpha);
      }
    }
    penX += (glyph.advance + tracking) * cap;
  }
  return penX - tracking * cap;
}

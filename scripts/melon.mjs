// The MelonSpeak mark: a watermelon slice, flat side up.
//
// Extracted from icons.mjs so the shipped extension icon and the store listing
// imagery are drawn from one description of the shape. The palette matches the
// product's own CSS custom properties (--melon, --rind in onboarding.css).
import { blend, smoothstep } from './png.mjs';

export const FLESH = [255, 92, 110];
export const WHITE = [247, 250, 240];
export const RIND = [42, 140, 74];
export const SEED = [40, 30, 34];

/** Brand colours shared with the stylesheets, for callers drawing alongside. */
export const MELON = [224, 74, 92]; // --melon  #e04a5c
export const RIND_CSS = [42, 140, 74]; // --rind   #2a8c4a
export const PANEL_BG = [16, 18, 20]; // the Now Reading view's ground #101214

/**
 * Draws the slice onto `canvas`.
 *
 * `cx`/`cyTop` are the centre of the circle the slice is cut from, which is
 * also the midpoint of its flat top edge; `R` is its radius. The slice
 * therefore occupies x ∈ [cx-R, cx+R] and y ∈ [cyTop, cyTop+R].
 *
 * `seeds` draws the pips, which are omitted at very small sizes where they
 * turn to mud. `aa` is the antialiasing width in pixels; callers rendering at
 * a known icon size pass their own so edge softness stays tied to that size
 * rather than to the radius.
 */
export function drawMelon(canvas, cx, cyTop, R, { seeds = true, aa = Math.max(0.8, R / 29.44) } = {}) {
  const seedCenters = seeds
    ? [255, 270, 285].map((deg) => {
        const a = (deg * Math.PI) / 180;
        return [cx + Math.cos(a) * R * 0.45, cyTop - Math.sin(a) * R * 0.45];
      })
    : [];
  const seedR = R * 0.075;

  const x0 = Math.floor(cx - R) - 2;
  const x1 = Math.ceil(cx + R) + 2;
  const y0 = Math.floor(cyTop) - 2;
  const y1 = Math.ceil(cyTop + R) + 2;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const r = Math.hypot(px - cx, py - cyTop);
      // Coverage: inside the circle AND below the flat top edge.
      const alpha = (1 - smoothstep(R - aa, R + aa, r)) * smoothstep(cyTop - aa, cyTop + aa, py);
      if (alpha <= 0.004) continue;
      let color;
      if (r <= R * 0.76) color = FLESH;
      else if (r <= R * 0.84) color = WHITE;
      else color = RIND;
      // Blend the band edges so flesh → pith → rind reads as one smooth cut.
      if (r > R * 0.76 - aa && r < R * 0.76 + aa) {
        const t = smoothstep(R * 0.76 - aa, R * 0.76 + aa, r);
        color = FLESH.map((c, i) => c + (WHITE[i] - c) * t);
      } else if (r > R * 0.84 - aa && r < R * 0.84 + aa) {
        const t = smoothstep(R * 0.84 - aa, R * 0.84 + aa, r);
        color = WHITE.map((c, i) => c + (RIND[i] - c) * t);
      }
      for (const [sx, sy] of seedCenters) {
        const sd = Math.hypot(px - sx, py - sy);
        if (sd < seedR + aa && r <= R * 0.7) {
          const t = 1 - smoothstep(seedR - aa, seedR + aa, sd);
          color = color.map((c, i) => c + (SEED[i] - c) * t);
        }
      }
      blend(canvas, x, y, color, alpha);
    }
  }
}

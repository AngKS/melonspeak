// Generates the MelonSpeak icon (a watermelon slice) as the PNGs shipped
// inside the extension. The shape itself lives in melon.mjs and the encoder in
// png.mjs, both shared with store-assets.mjs so the installed icon and the
// store listing show the same mark.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas, encodePng } from './png.mjs';
import { drawMelon } from './melon.mjs';

/** Sizes the manifests reference. */
const SIZES = [16, 32, 48, 128];

function icon(size) {
  const canvas = createCanvas(size, size);
  // Transparent ground: browser chrome supplies its own background, light or
  // dark. The slice is inset a touch from the edge and sits with its flat top
  // above centre, which optically centres a dome in a square.
  // aa is derived from the icon size, not the radius: these are rendered at
  // four fixed sizes and the edge should soften with the size the browser
  // actually shows.
  drawMelon(canvas, size / 2, size * 0.3, size * 0.46, {
    seeds: size >= 32,
    aa: Math.max(0.8, size / 64),
  });
  return encodePng(size, size, canvas.data);
}

mkdirSync('src/icons', { recursive: true });
for (const size of SIZES) {
  writeFileSync(`src/icons/icon${size}.png`, icon(size));
}
console.log('icons written to src/icons/');

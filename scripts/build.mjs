// Builds dist/chrome and dist/firefox from one codebase.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const dev = process.argv.includes('--dev');

const common = {
  bundle: true,
  target: 'es2022',
  platform: 'browser',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
  external: ['onnxruntime-node'],
  alias: {
    fs: './src/shims/empty.ts',
    'fs/promises': './src/shims/empty.ts',
    path: './src/shims/empty.ts',
  },
};

async function buildTarget(browser) {
  const out = `dist/${browser}`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // ESM app code with code splitting: heavy engine modules load only when used.
  await esbuild.build({
    ...common,
    entryPoints: {
      'player/player': 'src/player/player.ts',
      'player/engine-worker': 'src/player/engine-worker.ts',
      'popup/popup': 'src/popup/popup.ts',
      'onboarding/onboarding': 'src/onboarding/onboarding.ts',
      'reader/reader': 'src/reader/reader.ts',
    },
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    outdir: out,
  });

  // Classic scripts: service worker / event script and the injected content script.
  await esbuild.build({
    ...common,
    entryPoints: {
      background: 'src/background.ts',
      'content/extract': 'src/content/extract.ts',
      'content/selection-watch': 'src/content/selection-watch.ts',
    },
    format: 'iife',
    outdir: out,
  });

  // Static assets.
  cpSync(`src/manifest.${browser}.json`, `${out}/manifest.json`);
  cpSync('src/icons', `${out}/icons`, { recursive: true });
  for (const page of ['popup', 'onboarding', 'reader']) {
    cpSync(`src/${page}/${page}.html`, `${out}/${page}/${page}.html`);
    cpSync(`src/${page}/${page}.css`, `${out}/${page}/${page}.css`);
  }
  if (browser === 'chrome') {
    cpSync('src/player/offscreen.html', `${out}/player/offscreen.html`);
  } else {
    cpSync('src/player/background.html', `${out}/background.html`);
  }

  // ONNX Runtime WASM binaries, served from the extension itself (offline).
  // tjs/ is the runtime bundled inside transformers.js (used by Kokoro),
  // ort/ is the standalone onnxruntime-web used by the other engines.
  mkdirSync(`${out}/wasm/tjs`, { recursive: true });
  mkdirSync(`${out}/wasm/ort`, { recursive: true });
  for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
    cpSync(`node_modules/@huggingface/transformers/dist/${f}`, `${out}/wasm/tjs/${f}`);
  }
  for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
    cpSync(`node_modules/onnxruntime-web/dist/${f}`, `${out}/wasm/ort/${f}`);
  }
  // espeak-ng phonemizer for Piper.
  mkdirSync(`${out}/wasm/piper`, { recursive: true });
  for (const f of ['piper_phonemize.wasm', 'piper_phonemize.data']) {
    cpSync(`node_modules/@diffusionstudio/piper-wasm/build/${f}`, `${out}/wasm/piper/${f}`);
  }
  console.log(`built ${out}`);
}

await buildTarget('chrome');
await buildTarget('firefox');

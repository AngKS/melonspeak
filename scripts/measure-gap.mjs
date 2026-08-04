// Diagnostic harness: measures where the inter-chunk pause actually comes
// from. Reports, per chunk: synthesis wall time, audio duration, leading and
// trailing silence baked into the samples, and the real wall-clock cost of
// swapping the <audio> element's src between chunks.
//
// Not part of the test suite — run manually:
//   node scripts/measure-gap.mjs --model=kokoro
// Work is split into one evaluate() per chunk so a renderer crash surfaces
// as a failed step instead of an indefinite hang.
import puppeteer from 'puppeteer-core';
import * as esbuild from 'esbuild';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME =
  process.env.CHROME_BIN ??
  resolve(
    '../../../.chrome-for-testing/chrome/mac_arm-151.0.7922.71/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );
const EXT = resolve('dist/chrome');
const OUT = process.env.SMOKE_OUT ?? 'dist/measure';
const MODEL = process.argv.find((a) => a.startsWith('--model='))?.slice(8) ?? 'kokoro';
mkdirSync(OUT, { recursive: true });

// Real text from the article in the report, run through the real chunker.
const ARTICLE = `Every day afternoon, I have at least one build running somewhere, a dev server running, an SSH to my home server, one or two git clones in progress and finally, a Claude window I need to keep filling in with prompts.

This wasn't an issue of having too many windows open.

The issue was that the information I had to look out for was hidden away in one of them.

The only way to look out for that was to find the right window, and thus break focus from what I was doing.`;

const scratch = mkdtempSync(join(tmpdir(), 'melonspeak-measure-'));
await esbuild.build({
  entryPoints: { chunker: 'src/lib/chunker.ts', 'tts-normalize': 'src/lib/tts-normalize.ts' },
  bundle: true,
  format: 'esm',
  outdir: scratch,
});
const { chunkText } = await import(join(scratch, 'chunker.js'));
const { expandForSpeech } = await import(join(scratch, 'tts-normalize.js'));
const maxChars = { kokoro: 150, supertonic: 300, piper: 300 }[MODEL];
const chunks = chunkText(ARTICLE, maxChars).map((c) => expandForSpeech(c));
console.log(`model: ${MODEL}   chunks: ${chunks.length}`);
chunks.forEach((c, i) => console.log(`  [${i}] ${String(c.length).padStart(3)}c  ${JSON.stringify(c.slice(0, 58))}`));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--autoplay-policy=no-user-gesture-required',
  ],
  userDataDir: join(OUT, 'profile'),
  // Finite, so a dead renderer fails the step instead of hanging forever.
  protocolTimeout: 900_000,
});
browser.on('disconnected', () => console.error('  !! browser disconnected'));

const swTarget = await browser.waitForTarget(
  (t) => t.type() === 'service_worker' && t.url().includes('background.js'),
  { timeout: 15000 },
);
const extId = new URL(swTarget.url()).host;
const page = await browser.newPage();
page.on('console', (m) => console.log(`  [page] ${m.text()}`));
page.on('pageerror', (e) => console.error(`  [pageerror] ${e.message}`));
page.on('error', (e) => console.error(`  [crash] ${e.message}`));
await page.goto(`chrome-extension://${extId}/onboarding/onboarding.html`, {
  waitUntil: 'networkidle0',
});

// --- Stage 0: shared helpers + worker boot, parked on window --------------
await page.evaluate(async (modelId) => {
  const worker = new Worker(chrome.runtime.getURL('player/engine-worker.js'), { type: 'module' });
  window.__w = worker;
  window.__blobs = [];
  window.__wait = (pred, timeoutMs) =>
    new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('worker timeout')), timeoutMs);
      const onMsg = (e) => {
        if (e.data.type === 'error') {
          clearTimeout(timer);
          worker.removeEventListener('message', onMsg);
          rej(new Error(e.data.message));
        } else if (pred(e.data)) {
          clearTimeout(timer);
          worker.removeEventListener('message', onMsg);
          res(e.data);
        }
      };
      worker.addEventListener('message', onMsg);
    });
  window.__encodeWav = (samples, sampleRate) => {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const ascii = (o, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let o = 44;
    for (let i = 0; i < samples.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  };
  worker.postMessage({ type: 'download', modelId });
  await window.__wait((m) => m.type === 'downloaded', 900000);
  worker.postMessage({ type: 'load', modelId });
  await window.__wait((m) => m.type === 'loaded', 600000);
}, MODEL);
console.log('model ready');

// --- Stage 1: one synthesis per evaluate ----------------------------------
const results = [];
for (const [i, text] of chunks.entries()) {
  const r = await page.evaluate(
    async (text, id) => {
      const t0 = performance.now();
      window.__w.postMessage({ type: 'synthesize', id, text });
      const res = await window.__wait((m) => m.type === 'result' && m.id === id, 600000);
      const synthMs = performance.now() - t0;
      const { samples, sampleRate } = res;
      // Silence run at each end, at several thresholds so the number is not
      // an artifact of one arbitrary cutoff.
      const runs = (thresh) => {
        let lead = 0;
        while (lead < samples.length && Math.abs(samples[lead]) < thresh) lead++;
        let tail = 0;
        while (tail < samples.length && Math.abs(samples[samples.length - 1 - tail]) < thresh) tail++;
        return { lead: Math.round((lead / sampleRate) * 1000), tail: Math.round((tail / sampleRate) * 1000) };
      };
      window.__blobs.push(window.__encodeWav(samples, sampleRate));
      return {
        chars: text.length,
        synthMs: Math.round(synthMs),
        durationMs: Math.round((samples.length / sampleRate) * 1000),
        sampleRate,
        t001: runs(0.001),
        t005: runs(0.005),
        t02: runs(0.02),
      };
    },
    text,
    i + 1,
  );
  results.push(r);
  console.log(
    `  synth [${i}] ${r.synthMs}ms for ${r.durationMs}ms audio (RTF ${(r.synthMs / r.durationMs).toFixed(2)})  lead/tail@0.005 ${r.t005.lead}/${r.t005.tail}ms`,
  );
}

// --- Stage 2: cost of handing a fresh blob to the <audio> element ---------
// Headless Chrome has no audio sink, so 'ended' never fires and real-time
// playback can't be timed here. What *can* be timed is the part player.ts
// serializes into every boundary: assigning src and waiting for the element
// to load and decode far enough to start. Nothing is preloaded today, so the
// listener is only attached after the previous chunk has already ended.
const swaps = await page.evaluate(async () => {
  const out = [];
  for (let i = 0; i < window.__blobs.length; i++) {
    const audio = new Audio();
    if ('preservesPitch' in audio) audio.preservesPitch = true;
    const url = URL.createObjectURL(window.__blobs[i]);
    const t0 = performance.now();
    const stamp = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ event: 'timeout', ms: null }), 15000);
      const settle = (event) => {
        clearTimeout(timer);
        resolve({ event, ms: Math.round(performance.now() - t0) });
      };
      audio.addEventListener('canplaythrough', () => settle('canplaythrough'), { once: true });
      audio.addEventListener('error', () => settle('error'), { once: true });
      audio.preload = 'auto';
      audio.src = url;
      audio.load();
    });
    // play() never settles without an audio sink, so it is raced, not awaited.
    let played = false;
    try {
      await Promise.race([
        audio.play().then(() => {
          played = true;
        }),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    } catch {
      played = false;
    }
    audio.pause();
    URL.revokeObjectURL(url);
    out.push({ readyMs: stamp.ms, via: stamp.event, advanced: played });
  }
  return out;
});

await page.evaluate(() => window.__w.terminate());
await browser.close();

console.log('\n=== per-chunk synthesis ===');
console.log('idx chars  synthMs  audioMs   RTF    lead/tail silence ms @0.001 / @0.005 / @0.02');
results.forEach((r, i) => {
  const f = (s) => `${s.lead}/${s.tail}`;
  console.log(
    `${String(i).padStart(3)} ${String(r.chars).padStart(5)}  ${String(r.synthMs).padStart(7)}  ${String(r.durationMs).padStart(7)}  ${(r.synthMs / r.durationMs).toFixed(2).padStart(5)}   ${f(r.t001).padStart(10)} ${f(r.t005).padStart(10)} ${f(r.t02).padStart(10)}`,
  );
});

console.log('\n=== cost of handing a fresh blob to the <audio> element ===');
console.log('idx  src->canplaythrough  via              playback advanced');
swaps.forEach((s, i) => {
  console.log(
    `${String(i).padStart(3)}  ${String(s.readyMs).padStart(17)}  ${s.via.padEnd(15)}  ${s.advanced}`,
  );
});

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
// A boundary gap = trailing silence of chunk N + swap startup + leading silence of N+1.
const tails = results.slice(0, -1).map((r) => r.t005.tail);
const leads = results.slice(1).map((r) => r.t005.lead);
const startups = swaps.slice(1).map((s) => s.readyMs).filter((v) => v !== null);
console.log('\n=== gap budget per chunk boundary (avg) ===');
console.log(`  trailing silence, chunk N     : ${Math.round(avg(tails))} ms`);
console.log(`  element load+decode           : ${Math.round(avg(startups))} ms`);
console.log(`  leading silence, chunk N+1    : ${Math.round(avg(leads))} ms`);
console.log(`  ----------------------------- : ${Math.round(avg(tails) + avg(startups) + avg(leads))} ms of silence between spoken words`);
console.log(`\n  synthesis RTF (must stay < 1) : ${avg(results.map((r) => r.synthMs / r.durationMs)).toFixed(2)}`);

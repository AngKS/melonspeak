// Bundles TS modules under test to the scratch dir, then runs assertions.
import * as esbuild from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outdir = mkdtempSync(join(tmpdir(), 'melonspeak-test-'));
await esbuild.build({
  entryPoints: {
    chunker: 'src/lib/chunker.ts',
    'trim-silence': 'src/lib/trim-silence.ts',
    'readable-text': 'src/lib/readable-text.ts',
    'supertonic-text': 'src/engines/supertonic-text.ts',
    'tts-normalize': 'src/lib/tts-normalize.ts',
    'reading-tab': 'src/lib/reading-tab.ts',
    'reader-controls': 'src/lib/reader-controls.ts',
    'action-surface': 'src/lib/action-surface.ts',
    'cta-state': 'src/lib/cta-state.ts',
    settings: 'src/lib/settings.ts',
    'viz-levels': 'src/lib/viz-levels.ts',
    accel: 'src/engines/accel.ts',
  },
  bundle: true,
  format: 'esm',
  outdir,
});
const { chunkText } = await import(join(outdir, 'chunker.js'));
const { trimSilence } = await import(join(outdir, 'trim-silence.js'));
const { normalizeForTTS, expandForSpeech } = await import(join(outdir, 'tts-normalize.js'));
const { serializeReadable } = await import(join(outdir, 'readable-text.js'));
const { preprocessText, textToIds } = await import(join(outdir, 'supertonic-text.js'));
const { computeBadge, hasNavigatedAway } = await import(join(outdir, 'reading-tab.js'));
const { resolveSpaceAction, shouldFollowActiveLine, resolveFooterMode, resolveReadTarget } =
  await import(join(outdir, 'reader-controls.js'));
const { resolveActionSurface } = await import(join(outdir, 'action-surface.js'));
const { computeCtaView, previewSelection, formatDuration, isReadableUrl } = await import(
  join(outdir, 'cta-state.js')
);
const settingsMod = await import(join(outdir, 'settings.js'));
const { binLevels } = await import(join(outdir, 'viz-levels.js'));
const { wasmThreads, webgpuAvailable } = await import(join(outdir, 'accel.js'));

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}\n  ${err.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}\n  ${err.message}`);
  }
}

// Rejoining chunks must preserve every non-whitespace character in order.
const lettersOf = (s) => s.replace(/\s+/g, '');

// ---------------------------------------------------------------------------
// Chunker
// ---------------------------------------------------------------------------

test('empty input', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
});

test('single short sentence', () => {
  assert.deepEqual(chunkText('Hello world.'), ['Hello world.']);
});

test('merges short sentences up to maxLen', () => {
  const chunks = chunkText('One. Two. Three.', 12);
  assert.deepEqual(chunks, ['One. Two.', 'Three.']);
});

test('no text lost on plain prose', () => {
  const text =
    'The quick brown fox jumps over the lazy dog. ' +
    'Pack my box with five dozen liquor jugs! ' +
    'How vexingly quick daft zebras jump?';
  assert.equal(lettersOf(chunkText(text, 50).join(' ')), lettersOf(text));
});

test('overlong sentence is split and preserved', () => {
  // One giant sentence (no terminal punctuation until the end) forces the
  // clause/space hard-split path.
  const text =
    'lorem ipsum dolor sit amet, '.repeat(5) +
    'consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.';
  const chunks = chunkText(text, 100);
  for (const c of chunks) assert.ok(c.length <= 100, `chunk too long: ${c.length}`);
  assert.equal(lettersOf(chunks.join(' ')), lettersOf(text));
});

test('paragraph breaks are chunk boundaries', () => {
  const chunks = chunkText('A heading\n\nBody text here. More body.', 300);
  assert.equal(chunks[0], 'A heading');
  assert.equal(chunks[1], 'Body text here. More body.');
});

test('abbrev-heavy text is not dropped', () => {
  const text = 'Dr. Smith went to Washington D.C. on Jan. 5. It was cold.';
  assert.equal(lettersOf(chunkText(text, 300).join(' ')), lettersOf(text));
});

test('abbreviations never become chunk boundaries', () => {
  const text = 'Dr. Smith went to Washington D.C. on Jan. 5. It was cold.';
  assert.deepEqual(chunkText(text, 50), [
    'Dr. Smith went to Washington D.C. on Jan. 5.',
    'It was cold.',
  ]);
});

test('decimal numbers do not split sentences', () => {
  const chunks = chunkText('The price rose to 3.14 dollars today. Then it fell.', 45);
  assert.deepEqual(chunks, ['The price rose to 3.14 dollars today.', 'Then it fell.']);
});

test('unicode quotes and ellipsis boundaries', () => {
  const text = '“Wait…” she said. Then it happened! Right?';
  const chunks = chunkText(text, 20);
  assert.equal(lettersOf(chunks.join(' ')), lettersOf(text));
  for (const c of chunks) assert.ok(c.length <= 20);
});

test('single newlines are spaces, not boundaries', () => {
  const chunks = chunkText('line one\nline two.', 300);
  assert.deepEqual(chunks, ['line one line two.']);
});

// firstChunkMax: time-to-first-word is gated by the first chunk's synthesis
// time, so the read opens with small chunks and ramps up to full size.

test('first chunk is capped when firstChunkMax is given', () => {
  const sentence = 'This opening sentence is quite long and would normally form one big chunk. ';
  const text = sentence.repeat(6);
  const chunks = chunkText(text, 300, 80);
  assert.ok(chunks[0].length <= 80, `first chunk too long: ${chunks[0].length}`);
  assert.equal(lettersOf(chunks.join(' ')), lettersOf(text), 'text lost or duplicated');
  for (const c of chunks) assert.ok(c.length <= 300, `chunk too long: ${c.length}`);
});

test('firstChunkMax splits only the opening chunk, later ones stay full-size', () => {
  const text = 'Word. '.repeat(120);
  const chunks = chunkText(text, 300, 80);
  assert.ok(chunks[0].length <= 80);
  // The tail must still merge into large chunks — the cap is not global.
  assert.ok(
    chunks.some((c) => c.length > 200),
    `all ${chunks.length} chunks stayed small: ${chunks.map((c) => c.length).join(',')}`,
  );
});

test('an already-short first chunk is left alone', () => {
  assert.deepEqual(chunkText('Short one.\n\nSecond paragraph here.', 300, 80), [
    'Short one.',
    'Second paragraph here.',
  ]);
});

test('firstChunkMax >= maxLen changes nothing', () => {
  const text = 'One sentence here. Another sentence there. And a third one follows.';
  assert.deepEqual(chunkText(text, 60, 300), chunkText(text, 60));
});

// ---------------------------------------------------------------------------
// Readable-text serializer (extraction). Duck-typed DOM nodes: the serializer
// must not require a real browser DOM.
// ---------------------------------------------------------------------------

const txt = (s) => ({ nodeType: 3, nodeName: '#text', nodeValue: s, childNodes: [] });
const el = (name, ...children) => ({
  nodeType: 1,
  nodeName: name,
  nodeValue: null,
  childNodes: children.map((c) => (typeof c === 'string' ? txt(c) : c)),
  attrs: {},
  getAttribute(k) {
    return this.attrs[k] ?? null;
  },
});
const withAttr = (node, k, v) => {
  node.attrs[k] = v;
  return node;
};

test('adjacent blocks are separated even with no whitespace nodes', () => {
  // React/minified pages have zero whitespace between block elements.
  const tree = el('BODY', el('H2', 'Introduction'), el('P', 'Body text here.'));
  const out = serializeReadable(tree);
  assert.ok(!/Introduction\S/.test(out), `heading glued to body: ${JSON.stringify(out)}`);
  assert.deepEqual(chunkText(out), ['Introduction', 'Body text here.']);
});

test('paragraph boundaries survive into chunking', () => {
  const tree = el('BODY', el('P', 'First para.'), el('P', 'Second para.'));
  assert.deepEqual(chunkText(serializeReadable(tree)), ['First para.', 'Second para.']);
});

test('inline markup does not split or glue words', () => {
  const tree = el('P', 'Hello ', el('B', 'world'), '!');
  assert.deepEqual(chunkText(serializeReadable(tree)), ['Hello world!']);
});

test('script, style and aria-hidden content is dropped', () => {
  const tree = el(
    'BODY',
    el('P', 'Visible.'),
    el('SCRIPT', 'var x = 1;'),
    el('STYLE', '.a{color:red}'),
    withAttr(el('DIV', 'Screenreader-hidden junk.'), 'aria-hidden', 'true'),
  );
  const out = serializeReadable(tree);
  assert.ok(!out.includes('var x'), 'script leaked');
  assert.ok(!out.includes('color:red'), 'style leaked');
  assert.ok(!out.includes('junk'), 'aria-hidden leaked');
  assert.deepEqual(chunkText(out), ['Visible.']);
});

test('br is a soft break, not a paragraph boundary', () => {
  const tree = el('P', 'line one', el('BR'), 'line two.');
  assert.deepEqual(chunkText(serializeReadable(tree)), ['line one line two.']);
});

test('list items are separate speakable units', () => {
  const tree = el('UL', el('LI', 'First item'), el('LI', 'Second item'));
  assert.deepEqual(chunkText(serializeReadable(tree)), ['First item', 'Second item']);
});

test('table cells do not glue together', () => {
  const tree = el('TABLE', el('TR', el('TD', 'Name'), el('TD', 'Alice')));
  const out = serializeReadable(tree);
  assert.ok(/Name\s+Alice/.test(out), `cells glued: ${JSON.stringify(out)}`);
});

test('citation superscripts are silently skipped', () => {
  const tree = el('P', 'Well studied', el('SUP', '[12]'), ' fact.');
  assert.deepEqual(chunkText(serializeReadable(tree)), ['Well studied fact.']);
});

test('code blocks become a spoken marker, not verbatim code', () => {
  const tree = el('BODY', el('P', 'Before.'), el('PRE', 'const x = fn(1);'), el('P', 'After.'));
  const chunks = chunkText(serializeReadable(tree));
  assert.deepEqual(chunks, ['Before.', 'Code block omitted.', 'After.']);
});

// ---------------------------------------------------------------------------
// TTS normalization: invisible characters that web pages inject into words
// break phonemizers and cause skipped/garbled words.
// ---------------------------------------------------------------------------

test('soft hyphens are stripped so words stay whole', () => {
  assert.equal(normalizeForTTS('ex­ample'), 'example');
});

test('zero-width and word-joiner characters are stripped', () => {
  assert.equal(normalizeForTTS('zero​width‌‍⁠﻿x'), 'zerowidthx');
});

test('non-breaking and narrow spaces become plain spaces', () => {
  assert.equal(normalizeForTTS('12 000 km'), '12 000 km');
});

test('directional marks are stripped', () => {
  assert.equal(normalizeForTTS('a‎‏b‪c‬'), 'abc');
});

test('plain text passes through unchanged', () => {
  const s = 'Nothing to fix here — quotes “stay”, dashes stay.';
  assert.equal(normalizeForTTS(s), s);
});

test('URLs are replaced with a speakable placeholder', () => {
  assert.equal(
    normalizeForTTS('See https://ex.com/a/very?long=path#frag for details.'),
    'See (link) for details.',
  );
});

test('long runs of repeated characters collapse to three', () => {
  assert.equal(normalizeForTTS('No....... way!!!!!'), 'No... way!!!');
  assert.equal(normalizeForTTS('year 11111 unchanged'), 'year 11111 unchanged');
});

test('markdown-shaped links keep only their label', () => {
  assert.equal(normalizeForTTS('See [the docs](https://x.com/a) now.'), 'See the docs now.');
});

test('www URLs are also replaced', () => {
  assert.equal(normalizeForTTS('visit www.example.com today.'), 'visit (link) today.');
});

// ---------------------------------------------------------------------------
// expandForSpeech: applied per chunk at synthesis time (display keeps the
// original text). All three engines have documented gaps on digits, symbols
// and currency; espeak-family failure mode for odd tokens is a SILENT skip.
// ---------------------------------------------------------------------------

test('cardinals expand to words', () => {
  assert.equal(expandForSpeech('It has 42 members'), 'It has forty-two members.');
  assert.equal(expandForSpeech('1,234 items.'), 'one thousand two hundred thirty-four items.');
});

test('decimals read as point-digits', () => {
  assert.equal(expandForSpeech('Pi is 3.14.'), 'Pi is three point one four.');
});

test('ordinals expand', () => {
  assert.equal(expandForSpeech('the 3rd time and the 21st.'), 'the third time and the twenty-first.');
});

test('years read as year pairs', () => {
  assert.equal(expandForSpeech('built in 1984.'), 'built in nineteen eighty-four.');
  assert.equal(expandForSpeech('in 2026.'), 'in twenty twenty-six.');
  assert.equal(expandForSpeech('by 1900.'), 'by nineteen hundred.');
});

test('percent expands and letter-adjacent digits are left alone', () => {
  assert.equal(expandForSpeech('grew 12% in Q3.'), 'grew twelve percent in Q3.');
});

test('currency symbols expand with the amount', () => {
  assert.equal(expandForSpeech('a $5 fee.'), 'a five dollars fee.');
  assert.equal(expandForSpeech('a £1 coin.'), 'a one pound coin.');
  assert.equal(expandForSpeech('a €2.50 fare.'), 'a two point five zero euros fare.');
});

test('clock times read naturally', () => {
  assert.equal(expandForSpeech('Meet at 3:45 tomorrow.'), 'Meet at three forty-five tomorrow.');
});

test('ampersand and at-sign become words', () => {
  assert.equal(expandForSpeech('R&D dept @ HQ.'), 'R and D dept at HQ.');
});

test('missing terminal punctuation is added', () => {
  assert.equal(expandForSpeech('A heading'), 'A heading.');
});

test('clean prose passes through', () => {
  assert.equal(expandForSpeech('Nothing to expand here.'), 'Nothing to expand here.');
});

test('chunker applies TTS normalization', () => {
  assert.deepEqual(chunkText('ex­ample one.'), ['example one.']);
});

// ---------------------------------------------------------------------------
// Silence trimming. Every engine pads its output with silence (measured on
// Kokoro: ~320 ms leading, ~490 ms trailing), and that padding lands at every
// chunk boundary twice over, which is most of the unnatural inter-chunk pause.
// ---------------------------------------------------------------------------

const SR = 1000; // 1 sample per ms keeps the arithmetic readable
/** Constant-amplitude signal; never dips below the silence threshold. */
const tone = (n, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => (i % 2 ? amp : -amp));
const silence = (n) => new Float32Array(n);
const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

test('leading and trailing silence are trimmed down to the pad', () => {
  const out = trimSilence(concat(silence(500), tone(1000), silence(800)), SR, 60);
  assert.equal(out.length, 60 + 1000 + 60);
});

test('audio with no silence to trim is returned unchanged', () => {
  const out = trimSilence(tone(500), SR, 60);
  assert.equal(out.length, 500);
});

test('the pad never invents samples that were not there', () => {
  const out = trimSilence(concat(silence(10), tone(100), silence(10)), SR, 60);
  assert.equal(out.length, 10 + 100 + 10);
});

test('an entirely silent chunk trims to nothing instead of returning garbage', () => {
  assert.equal(trimSilence(silence(1000), SR, 60).length, 0);
});

test('quiet speech is not mistaken for silence', () => {
  assert.equal(trimSilence(tone(500, 0.02), SR, 0).length, 500);
});

test('trimming keeps the speech itself sample-for-sample', () => {
  const speech = tone(200);
  const out = trimSilence(concat(silence(300), speech, silence(300)), SR, 0);
  assert.deepEqual(Array.from(out), Array.from(speech));
});

// ---------------------------------------------------------------------------
// Supertonic text frontend
// ---------------------------------------------------------------------------

test('textToIds emits one id per character, not per UTF-16 unit', () => {
  const indexer = new Array(0x10000).fill(7);
  const ids = textToIds('a\u{1D11E}b', indexer); // 𝄞 is outside the BMP
  assert.equal(ids.length, 3, `expected 3 ids, got ${ids.length}`);
  assert.equal(ids[0], 7n);
  assert.equal(ids[1], -1n, 'astral char must map to unknown, not a surrogate id');
  assert.equal(ids[2], 7n);
});

test('preprocessText normalizes without destroying words', () => {
  const out = preprocessText('Hello there world');
  assert.ok(out.startsWith('<en>') && out.endsWith('</en>'), out);
  assert.ok(out.includes('Hello there world'), out);
});

// Supertone maintainer confirmed (supertonic#31): text is NOT split at em
// dashes/semicolons, the duration predictor under-allocates, and words get
// swallowed. Turning them into sentence breaks is the documented fix.
test('supertonic: em dashes become sentence breaks', () => {
  assert.equal(preprocessText('Alpha — beta'), '<en>Alpha. beta.</en>');
  assert.equal(preprocessText('one—two'), '<en>one. two.</en>');
});

test('supertonic: semicolons become sentence breaks', () => {
  assert.equal(preprocessText('first; second'), '<en>first. second.</en>');
});

// ---------------------------------------------------------------------------
// Settings: concurrent read-modify-writes must not lose updates.
// ---------------------------------------------------------------------------

const store = { settings: undefined };
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        await new Promise((r) => setTimeout(r, 1));
        return store.settings === undefined ? {} : { [key]: store.settings };
      },
      async set(obj) {
        await new Promise((r) => setTimeout(r, 1));
        store.settings = obj.settings;
      },
    },
  },
};

await testAsync('concurrent downloaded-flag mutations are not lost', async () => {
  store.settings = undefined;
  const { mutateSettings } = settingsMod;
  await Promise.all([
    mutateSettings((s) => ({ downloaded: { ...s.downloaded, kokoro: true } })),
    mutateSettings((s) => ({ downloaded: { ...s.downloaded, piper: true } })),
  ]);
  assert.equal(store.settings.downloaded.kokoro, true, 'kokoro flag lost');
  assert.equal(store.settings.downloaded.piper, true, 'piper flag lost');
});

await testAsync('mutateSettings merges defaults and returns the result', async () => {
  store.settings = undefined;
  const { mutateSettings } = settingsMod;
  const next = await mutateSettings(() => ({ speed: 1.5 }));
  assert.equal(next.speed, 1.5);
  assert.equal(next.onboarded, false);
});

// -- reading-tab badge ------------------------------------------------------

const badge = (over) =>
  computeBadge({
    readingTabId: 7,
    activeTabId: 7,
    playerState: 'speaking',
    stopReason: null,
    ...over,
  });

test('no badge while the tab being read is the active tab', () => {
  assert.equal(badge({}), 'none');
});

test('badge appears once another tab is active', () => {
  assert.equal(badge({ activeTabId: 9 }), 'background');
});

test('badge covers paused and preparing, not just speaking', () => {
  assert.equal(badge({ activeTabId: 9, playerState: 'paused' }), 'background');
  assert.equal(badge({ activeTabId: 9, playerState: 'preparing' }), 'background');
});

test('a finished or idle read is not "backgrounded"', () => {
  for (const playerState of ['idle', 'loading-model', 'error']) {
    assert.equal(badge({ activeTabId: 9, playerState }), 'none', playerState);
  }
});

test('unknown reading or active tab shows nothing rather than guessing', () => {
  assert.equal(badge({ readingTabId: null, activeTabId: 9 }), 'none');
  assert.equal(badge({ activeTabId: null }), 'none');
});

test('tab-closed outranks playback state, which is idle by then', () => {
  assert.equal(
    badge({ readingTabId: null, activeTabId: 9, playerState: 'idle', stopReason: 'tab-closed' }),
    'stopped-tab-closed',
  );
});

// -- reading-tab: the tab navigated away from what we are reading -----------

test('same-tab navigation is badged even though that tab is still active', () => {
  assert.equal(badge({ navigated: true }), 'navigated');
});

test('navigation outranks backgrounding: the page is gone, not merely behind', () => {
  assert.equal(badge({ navigated: true, activeTabId: 9 }), 'navigated');
});

test('a closed tab outranks a navigated one', () => {
  assert.equal(
    badge({ readingTabId: null, navigated: true, playerState: 'idle', stopReason: 'tab-closed' }),
    'stopped-tab-closed',
  );
});

test('navigation is not badged once the read is over', () => {
  for (const playerState of ['idle', 'loading-model', 'error']) {
    assert.equal(badge({ navigated: true, playerState }), 'none', playerState);
  }
});

test('a navigated read needs no active tab to be badged', () => {
  assert.equal(badge({ navigated: true, activeTabId: null }), 'navigated');
});

test('the same address is not a navigation', () => {
  assert.equal(hasNavigatedAway('https://ex.com/a', 'https://ex.com/a'), false);
});

test('a trailing slash is the same address', () => {
  assert.equal(hasNavigatedAway('https://ex.com', 'https://ex.com/'), false);
});

test('an anchor jump keeps the document it was reading', () => {
  assert.equal(hasNavigatedAway('https://ex.com/a#top', 'https://ex.com/a#part-2'), false);
});

test('a different path is a navigation', () => {
  assert.equal(hasNavigatedAway('https://ex.com/a', 'https://ex.com/b'), true);
});

test('a different query is a navigation: it is different content', () => {
  assert.equal(hasNavigatedAway('https://ex.com/a?page=1', 'https://ex.com/a?page=2'), true);
});

test('an unknown or unparseable address never claims a navigation', () => {
  assert.equal(hasNavigatedAway(undefined, 'https://ex.com/a'), false);
  assert.equal(hasNavigatedAway('https://ex.com/a', undefined), false);
  assert.equal(hasNavigatedAway('not a url', 'https://ex.com/a'), false);
});

// -- acceleration gating ----------------------------------------------------
// Threads must engage only when BOTH the beta toggle and cross-origin
// isolation are present; everything else silently stays at 1.

test('accel off means one thread, isolated or not', () => {
  delete globalThis.crossOriginIsolated;
  assert.equal(wasmThreads(false), 1);
  globalThis.crossOriginIsolated = true;
  assert.equal(wasmThreads(false), 1);
  delete globalThis.crossOriginIsolated;
});

test('accel without isolation stays at one thread (Firefox path)', () => {
  delete globalThis.crossOriginIsolated;
  assert.equal(wasmThreads(true), 1);
});

test('accel with isolation uses cores-1 capped at 4', () => {
  globalThis.crossOriginIsolated = true;
  const cores = navigator.hardwareConcurrency ?? 2;
  assert.equal(wasmThreads(true), Math.min(4, Math.max(1, cores - 1)));
  delete globalThis.crossOriginIsolated;
});

await testAsync('webgpuAvailable is false (not a crash) with no adapter', async () => {
  assert.equal(await webgpuAvailable(), false); // node has no navigator.gpu
});

// -- visualizer bin→bar mapping ---------------------------------------------
// The analyser spans the AudioContext's Nyquist (24 kHz at a 48 kHz device
// rate), but TTS audio is band-limited to its own Nyquist (11–12 kHz), so a
// linear map leaves the right half of the bars permanently dead.

const VIZ_CTX_RATE = 48000; // typical device rate; analyser spans 0–24 kHz
const VIZ_FFT_BINS = 1024; // fftSize 2048
const hzPerBin = VIZ_CTX_RATE / 2 / VIZ_FFT_BINS;

/** Bins with flat energy below `cutoffHz` and silence above — the spectrum
 *  of band-limited TTS audio after Chrome resamples it into the context. */
function bandLimitedBins(cutoffHz) {
  const bins = new Uint8Array(VIZ_FFT_BINS);
  for (let i = 0; i < bins.length; i++) bins[i] = i * hzPerBin < cutoffHz ? 200 : 0;
  return bins;
}

test('every bar moves for 24 kHz (Kokoro) audio in a 48 kHz context', () => {
  const levels = binLevels(bandLimitedBins(12000), VIZ_CTX_RATE, 24);
  assert.equal(levels.length, 24);
  for (let b = 0; b < 24; b++) {
    assert.ok(levels[b] > 0.1, `bar ${b} is dead (${levels[b]})`);
  }
});

test('every bar moves for 22.05 kHz (Piper) audio too', () => {
  const levels = binLevels(bandLimitedBins(11025), VIZ_CTX_RATE, 24);
  for (let b = 0; b < 24; b++) {
    assert.ok(levels[b] > 0.1, `bar ${b} is dead (${levels[b]})`);
  }
});

test('silence maps to all-zero bars', () => {
  const levels = binLevels(new Uint8Array(VIZ_FFT_BINS), VIZ_CTX_RATE, 24);
  assert.ok(levels.every((v) => v === 0));
});

test('a low hum lights low bars, a 5 kHz tone lights high bars', () => {
  const low = new Uint8Array(VIZ_FFT_BINS);
  low[Math.round(120 / hzPerBin)] = 255; // ~120 Hz
  const lowLevels = binLevels(low, VIZ_CTX_RATE, 24);
  const lowPeak = lowLevels.indexOf(Math.max(...lowLevels));

  const high = new Uint8Array(VIZ_FFT_BINS);
  high[Math.round(5000 / hzPerBin)] = 255; // ~5 kHz
  const highLevels = binLevels(high, VIZ_CTX_RATE, 24);
  const highPeak = highLevels.indexOf(Math.max(...highLevels));

  assert.ok(lowPeak < 6, `120 Hz peaked at bar ${lowPeak}`);
  assert.ok(highPeak > 15, `5 kHz peaked at bar ${highPeak}`);
  assert.ok(highLevels[0] === 0, 'tone leaked into the lowest bar');
});

test('bars read distinct bands — no wide plateaus of duplicated bins', () => {
  // With a 2048-point FFT every bar's band starts at a different bin, so a
  // regression to a coarse FFT (e.g. fftSize 128) would fail this.
  const ramp = new Uint8Array(VIZ_FFT_BINS);
  for (let i = 0; i < ramp.length; i++) ramp[i] = Math.min(255, i);
  const levels = binLevels(ramp, VIZ_CTX_RATE, 24);
  const distinct = new Set(levels.map((v) => v.toFixed(4))).size;
  assert.ok(distinct >= 20, `only ${distinct} distinct bar levels`);
});

// ---------------------------------------------------------------------------
// Reader controls: spacebar action + follow-the-active-line gate
// ---------------------------------------------------------------------------

const ALL_STATES = ['idle', 'preparing', 'loading-model', 'speaking', 'paused', 'error'];

const space = (playerState, focusIsInteractive = false) =>
  resolveSpaceAction({ playerState, focusIsInteractive });

test('space pauses a speaking read and resumes a paused one', () => {
  assert.equal(space('speaking'), 'pause');
  assert.equal(space('paused'), 'resume');
});

test('space does nothing in states with no playback to toggle', () => {
  for (const state of ['idle', 'preparing', 'loading-model', 'error']) {
    assert.equal(space(state), 'none', state);
  }
});

// Otherwise Stop, Voice model, and the backgrounded header would lose the key
// the browser already gives them.
test('a focused button keeps space for itself in every state', () => {
  for (const state of ALL_STATES) {
    assert.equal(space(state, true), 'none', state);
  }
});

test('the transcript follows the active line only while a read is live', () => {
  for (const state of ['speaking', 'paused', 'preparing']) {
    assert.equal(shouldFollowActiveLine(state), true, state);
  }
  for (const state of ['idle', 'loading-model', 'error']) {
    assert.equal(shouldFollowActiveLine(state), false, state);
  }
});

// ---------------------------------------------------------------------------
// Panel footer mode
// ---------------------------------------------------------------------------

test('with no model installed and nothing playing the footer offers setup', () => {
  assert.equal(resolveFooterMode('idle', false), 'setup');
  assert.equal(resolveFooterMode('error', false), 'setup');
});

// Removing the last model from the onboarding tab mid-read must not strand the
// user with audio playing and no Stop button.
test('a live read keeps its transport even with no model left installed', () => {
  for (const state of ['speaking', 'paused', 'preparing', 'loading-model']) {
    assert.equal(resolveFooterMode(state, false), 'reading', state);
  }
});

test('a live read shows the transport, including while it is still starting', () => {
  for (const state of ['speaking', 'paused', 'preparing', 'loading-model']) {
    assert.equal(resolveFooterMode(state, true), 'reading', state);
  }
});

// An error leaves nothing to pause or stop, so the read buttons come back and
// the user can simply try again.
test('idle and error offer the read buttons', () => {
  assert.equal(resolveFooterMode('idle', true), 'idle');
  assert.equal(resolveFooterMode('error', true), 'idle');
});

// ---------------------------------------------------------------------------
// Which tab a read started from the panel targets
// ---------------------------------------------------------------------------

test('the panel names the active tab of its own window', () => {
  assert.equal(resolveReadTarget({ activeTabId: 7, ownTabId: null }), 7);
});

// Open as a tab (the surface nothing links to any more), the view IS the
// active tab. Reading an extension page is never what was asked for, so it
// defers instead of naming itself.
test('a reading view open as a tab never targets itself', () => {
  assert.equal(resolveReadTarget({ activeTabId: 7, ownTabId: 7 }), undefined);
});

test('with no active tab known the background decides', () => {
  assert.equal(resolveReadTarget({ activeTabId: null, ownTabId: null }), undefined);
});

// ---------------------------------------------------------------------------
// Which surface the toolbar button opens
// ---------------------------------------------------------------------------

const surface = (hasSidePanel, hasSidebarAction) =>
  resolveActionSurface({ hasSidePanel, hasSidebarAction });

test('Chrome opens its side panel', () => {
  assert.equal(surface(true, false), 'side-panel');
});

test('Firefox opens its sidebar', () => {
  assert.equal(surface(false, true), 'sidebar');
});

// Only reachable in a browser with neither API: the reading view is served as
// the action popup instead, so no control becomes unreachable.
test('with neither API the reading view becomes the popup', () => {
  assert.equal(surface(false, false), 'popup');
});

test('the side panel wins if a browser somehow offers both', () => {
  assert.equal(surface(true, true), 'side-panel');
});

// CTA cards (idle-state call to action)
// ---------------------------------------------------------------------------

const view = (playerState, hasLines, stopReason = null) =>
  computeCtaView({ playerState, hasLines, stopReason });

test('cards stay out of the way while audio is playing', () => {
  assert.equal(view('speaking', true), 'hidden');
  assert.equal(view('paused', true), 'hidden');
  assert.equal(view('loading-model', true), 'hidden');
});

test('preparing hides the cards even with no transcript yet', () => {
  // Something is already on its way; offering a second request here would
  // cancel the first.
  assert.equal(view('preparing', false), 'hidden');
  assert.equal(view('preparing', true), 'hidden');
});

test('idle with nothing read gives the full-size cards', () => {
  assert.equal(view('idle', false), 'full');
});

test('a finished read keeps its transcript and tucks the cards underneath', () => {
  assert.equal(view('idle', true), 'compact');
});

test('errors offer a way forward instead of a dead end', () => {
  assert.equal(view('error', false), 'full');
  assert.equal(view('error', true), 'compact');
});

test('a tab-close stop keeps the transcript, whatever the player state says', () => {
  // stopAll() broadcasts an empty transcript, so hasLines can be false here
  // while the view still shows the dimmed lyrics it deliberately kept.
  assert.equal(view('idle', true, 'tab-closed'), 'compact');
  assert.equal(view('idle', false, 'tab-closed'), 'compact');
});

test('selection preview counts words and quotes the text', () => {
  const s = previewSelection('Hello there, wonderful world');
  assert.equal(s.words, 4);
  assert.equal(s.quote, 'Hello there, wonderful world');
  assert.equal(s.chars, 28);
});

test('whitespace-only selection previews as empty', () => {
  const s = previewSelection('   \n\t  ');
  assert.equal(s.words, 0);
  assert.equal(s.quote, '');
  assert.equal(s.chars, 0);
});

test('long selections are clamped for the quote but counted in full', () => {
  const text = 'word '.repeat(400).trim(); // 400 words, 1999 chars
  const s = previewSelection(text);
  assert.equal(s.words, 400);
  assert.equal(s.chars, 1999);
  assert.ok(s.quote.length <= 241, `quote was ${s.quote.length} chars`);
  assert.ok(s.quote.endsWith('…'), `no ellipsis: ${JSON.stringify(s.quote.slice(-10))}`);
});

test('newlines in a selection collapse into a single-line quote', () => {
  const s = previewSelection('first line\n\n  second line  ');
  assert.equal(s.quote, 'first line second line');
  assert.equal(s.words, 4);
});

test('duration scales with the saved speed', () => {
  const words = 330; // ≈ 2 min at 165 wpm
  assert.equal(formatDuration(words, 1), '~2 min');
  assert.equal(formatDuration(words, 2), '~1 min');
});

test('short selections read in seconds, not "0 min"', () => {
  assert.match(formatDuration(6, 1), /^~\d+ s$/);
});

test('speed of zero or nonsense never yields Infinity or NaN', () => {
  // settings.speed is user-editable; a bad value must not reach the UI.
  for (const speed of [0, -1, NaN, undefined]) {
    const d = formatDuration(3, speed);
    assert.match(d, /^~\d+ (s|min)$/, `speed ${speed} produced ${JSON.stringify(d)}`);
  }
});

test('no words means no duration string at all', () => {
  assert.equal(formatDuration(0, 1), '');
});

test('pages no extension can script are refused up front', () => {
  assert.equal(isReadableUrl('https://example.com/article'), true);
  assert.equal(isReadableUrl('http://localhost:8080/'), true);
  assert.equal(isReadableUrl('file:///Users/me/notes.html'), true);
  assert.equal(isReadableUrl('chrome://settings'), false);
  assert.equal(isReadableUrl('about:blank'), false);
  assert.equal(isReadableUrl('moz-extension://abc/reader.html'), false);
  assert.equal(isReadableUrl('chrome-extension://abc/reader.html'), false);
  assert.equal(isReadableUrl('https://chromewebstore.google.com/detail/x'), false);
  assert.equal(isReadableUrl('https://addons.mozilla.org/en-US/firefox/'), false);
  assert.equal(isReadableUrl(undefined), false);
});

// ---------------------------------------------------------------------------
// Distribution manifests. These assert store-blocking facts that are invisible
// until an upload is rejected — the kind of thing a refactor silently undoes.
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const chromeManifest = JSON.parse(readFileSync('src/manifest.chrome.json', 'utf8'));
const firefoxManifest = JSON.parse(readFileSync('src/manifest.firefox.json', 'utf8'));

test('the extension version is a shape both stores accept', () => {
  // Chrome: 1-4 dot-separated integers, 0-65535, no pre-release suffix.
  assert.match(pkg.version, /^\d{1,5}(\.\d{1,5}){0,3}$/);
  for (const part of pkg.version.split('.')) {
    assert.ok(Number(part) <= 65535, `version part ${part} exceeds 65535`);
  }
});

test('the Firefox manifest declares its data collection', () => {
  // Mandatory for new AMO submissions since 2025-11-03: without this key the
  // submission is rejected outright. MelonSpeak transmits nothing.
  const gecko = firefoxManifest.browser_specific_settings?.gecko;
  assert.deepEqual(gecko?.data_collection_permissions, { required: ['none'] });
});

test('the Firefox minimum version can actually read that declaration', () => {
  // data_collection_permissions needs Firefox 140+; promising an older floor
  // ships the key to browsers that ignore it.
  const min = Number(
    firefoxManifest.browser_specific_settings?.gecko?.strict_min_version?.split('.')[0],
  );
  assert.ok(min >= 140, `strict_min_version is ${min}, needs >= 140`);
});

test('both manifests declare only permissions the code uses', () => {
  // An unused permission is a documented Chrome Web Store rejection reason.
  const source = ['src', 'scripts']
    .flatMap((dir) => readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((f) => join(dir, f)))
    .filter((f) => /\.(ts|mjs)$/.test(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  // Every Chrome permission maps to a chrome.<permission> namespace, so the
  // call site is derivable rather than listed — a permission added later is
  // checked by default instead of silently skipped. Only permissions that
  // grant a capability with no API surface of their own are exempt, and each
  // has to be named here deliberately.
  const NO_API_SURFACE = new Set(['activeTab', 'unlimitedStorage']);
  for (const [name, manifest] of [
    ['chrome', chromeManifest],
    ['firefox', firefoxManifest],
  ]) {
    for (const perm of manifest.permissions) {
      if (NO_API_SURFACE.has(perm)) continue;
      assert.ok(
        source.includes(`chrome.${perm}`),
        `${name} declares "${perm}" but never calls chrome.${perm} — ` +
          `an unused permission is a documented store rejection reason`,
      );
    }
  }
});

test('neither manifest can load remote code', () => {
  // MV3 forbids remotely hosted code; a CSP that allowed it would be a
  // rejection at review, and 'wasm-unsafe-eval' is the one addition needed to
  // run the bundled ONNX runtime.
  for (const [name, manifest] of [
    ['chrome', chromeManifest],
    ['firefox', firefoxManifest],
  ]) {
    const csp = manifest.content_security_policy.extension_pages;
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/, `${name} CSP`);
    assert.ok(!/https?:/.test(csp), `${name} CSP allows a remote origin: ${csp}`);
  }
});

test('the store listings document every permission that is declared', () => {
  // A permission with no written justification is the most common Chrome Web
  // Store rejection; this keeps the docs honest as the manifests change.
  const listings =
    readFileSync('docs/store/chrome-listing.md', 'utf8') +
    readFileSync('docs/store/firefox-listing.md', 'utf8');
  const declared = new Set([...chromeManifest.permissions, ...firefoxManifest.permissions]);
  for (const perm of declared) {
    assert.ok(listings.includes(perm), `no justification written for "${perm}"`);
  }
  assert.ok(listings.includes('<all_urls>'), 'no justification written for host_permissions');
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll tests passed');

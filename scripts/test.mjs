// Bundles TS modules under test to the scratch dir, then runs assertions.
import * as esbuild from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outdir = mkdtempSync(join(tmpdir(), 'melonspeak-test-'));
await esbuild.build({
  entryPoints: {
    chunker: 'src/lib/chunker.ts',
    'readable-text': 'src/lib/readable-text.ts',
    'supertonic-text': 'src/engines/supertonic-text.ts',
    'tts-normalize': 'src/lib/tts-normalize.ts',
    'reading-tab': 'src/lib/reading-tab.ts',
    settings: 'src/lib/settings.ts',
  },
  bundle: true,
  format: 'esm',
  outdir,
});
const { chunkText } = await import(join(outdir, 'chunker.js'));
const { normalizeForTTS, expandForSpeech } = await import(join(outdir, 'tts-normalize.js'));
const { serializeReadable } = await import(join(outdir, 'readable-text.js'));
const { preprocessText, textToIds } = await import(join(outdir, 'supertonic-text.js'));
const { computeBadge } = await import(join(outdir, 'reading-tab.js'));
const settingsMod = await import(join(outdir, 'settings.js'));

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

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll tests passed');

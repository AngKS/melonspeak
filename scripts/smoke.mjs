// Loads the built extension into a real (headless) Chrome and verifies the
// surfaces boot without errors. With --download it also downloads the Piper
// model and runs a real end-to-end synthesis check.
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import {
  MB,
  cardState,
  clickRemove,
  inspectStorage,
  isStored,
  storageProblems,
} from './storage-probe.mjs';

const CHROME = process.env.CHROME_BIN ?? '.chrome-for-testing/chrome/mac_arm-151.0.7922.71/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const EXT = resolve('dist/chrome');
const OUT = process.env.SMOKE_OUT ?? 'dist/smoke';
const DO_DOWNLOAD = process.argv.includes('--download');
const DO_ACCEL = process.argv.includes('--accel');
const MODEL = process.argv.find((a) => a.startsWith('--model='))?.slice(8) ?? 'piper';
const MODEL_INDEX = { kokoro: 0, supertonic: 1, piper: 2 }[MODEL];
const FRESH = !existsSync(join(OUT, 'profile'));
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell' === 'never' ? false : true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--hide-crash-restore-bubble',
  ],
  userDataDir: join(OUT, 'profile'),
});

const errors = [];
const pageErrors = (page, label) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[${label}] console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[${label}] pageerror: ${err.message}`));
};

// Find the extension id via the service worker target.
const swTarget = await browser.waitForTarget(
  (t) => t.type() === 'service_worker' && t.url().includes('background.js'),
  { timeout: 15000 },
);
const extId = new URL(swTarget.url()).host;
console.log('extension id:', extId);

async function openPage(path, label) {
  const page = await browser.newPage();
  pageErrors(page, label);
  await page.goto(`chrome-extension://${extId}/${path}`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: join(OUT, `${label}.png`) });
  return page;
}

const onboarding = await openPage('onboarding/onboarding.html', 'onboarding');
const cardCount = await onboarding.$$eval('.card', (els) => els.length);
console.log('onboarding cards:', cardCount);
if (cardCount !== 3) errors.push(`expected 3 model cards, got ${cardCount}`);

if (FRESH) {
  // Nothing is downloaded yet, so no card may show the installed badge —
  // checked on computed style, since an author `display:` can override
  // the `hidden` attribute and that is exactly how this once regressed.
  for (let i = 0; i < cardCount; i++) {
    const state = await cardState(onboarding, i);
    if (state.installedVisible) errors.push(`card ${i} shows "Installed" on a fresh profile`);
    if (state.progressVisible) errors.push(`card ${i} shows a progress bar before downloading`);
  }
}
const sizesShown = await onboarding.$$eval('.real', (els) => els.map((e) => e.textContent.trim()));
console.log('model lines:', sizesShown);

if (FRESH) {
  // A leftover settings flag (cache evicted, site data cleared, download that
  // never finished writing) must not resurrect the badge — the page checks the
  // files and corrects the record.
  await onboarding.evaluate(async () => {
    await chrome.storage.local.set({
      settings: {
        downloaded: { kokoro: true, piper: true },
        selectedModel: 'kokoro',
        voices: {},
        speed: 1,
        onboarded: true,
      },
    });
  });
  await onboarding.reload({ waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));
  for (let i = 0; i < cardCount; i++) {
    if ((await cardState(onboarding, i)).installedVisible) {
      errors.push(`card ${i} shows "Installed" for a model whose files are gone`);
    }
  }
  const reconciled = await onboarding.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    return settings;
  });
  console.log('settings after reconciling a stale flag:', JSON.stringify(reconciled));
  if (Object.values(reconciled?.downloaded ?? {}).some(Boolean)) {
    errors.push('stale downloaded flags were not cleared');
  }
  if (reconciled?.selectedModel !== null) {
    errors.push(`selectedModel should be null, got ${reconciled?.selectedModel}`);
  }
}

// The toolbar button must open the panel, not a popup: the panel is the only
// surface carrying the settings and controls now.
{
  const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
  console.log('action keys:', Object.keys(manifest.action).join(', '));
  if (manifest.action.default_popup) {
    errors.push('action still declares a default_popup; the toolbar button must open the panel');
  }
  if (manifest.side_panel?.default_path !== 'reader/reader.html') {
    errors.push('side_panel no longer points at the reading view');
  }
}

const reader = await openPage('reader/reader.html', 'reader');

const setupVisible = await reader.$eval('#setup-actions', (el) => !el.hidden);
console.log('panel shows setup prompt (no models yet):', setupVisible);
if (!setupVisible && FRESH) errors.push('panel should show setup prompt on a fresh profile');

// Every control the popup used to own must be reachable from the panel.
const sheet = await reader.evaluate(async () => {
  const open = () => document.getElementById('menu-btn').click();
  open();
  await new Promise((r) => setTimeout(r, 100));
  return {
    expanded: document.getElementById('menu-btn').getAttribute('aria-expanded'),
    sheetVisible: !document.getElementById('sheet').hidden,
    hasSpeed: Boolean(document.getElementById('speed')),
    hasManage: Boolean(document.getElementById('manage')),
    modelItems: document.querySelectorAll('#model-list .model-item').length,
  };
});
console.log('settings sheet:', JSON.stringify(sheet));
if (!sheet.sheetVisible || sheet.expanded !== 'true') {
  errors.push('the ☰ button did not open the settings sheet');
}
if (!sheet.hasSpeed || !sheet.hasManage) {
  errors.push('the settings sheet is missing the speed control or the model manager link');
}
if (FRESH && sheet.modelItems !== 0) {
  errors.push(`fresh profile listed ${sheet.modelItems} installed models`);
}
await reader.evaluate(() => document.getElementById('scrim').click());

// Idle reads come from the CTA cards; the footer's split button covers the one
// case they don't — starting a new read while one is already playing.
const readButtons = await reader.evaluate(() =>
  ['cta-page', 'cta-selection', 'read-page-live', 'menu-read-selection'].filter(
    (id) => !document.getElementById(id),
  ),
);
if (readButtons.length) errors.push(`panel is missing read controls: ${readButtons.join(', ')}`);
// With nothing being read the badge machinery must be completely inert, and
// the header must not advertise a click target it won't honour.
const badgeIdle = await reader.evaluate(() => ({
  hidden: document.getElementById('bg-badge').hidden,
  interactive: document.getElementById('head').hasAttribute('role'),
}));
console.log('reader badge idle state:', badgeIdle);
if (!badgeIdle.hidden) errors.push('badge should be hidden with nothing being read');
if (badgeIdle.interactive) errors.push('header should not be interactive with no reading tab');

// storage.session is the reading view's source of truth, so it must be
// readable straight from an extension page with no background round-trip.
const sessionReadable = await reader.evaluate(async () => {
  try {
    const v = await chrome.storage.session.get('readingTab');
    return v.readingTab === undefined ? 'empty' : `set:${JSON.stringify(v.readingTab)}`;
  } catch (err) {
    return `error:${String(err)}`;
  }
});
console.log('reader reads storage.session directly:', sessionReadable);
if (sessionReadable !== 'empty') {
  errors.push(`expected no reading tab on a fresh profile, got ${sessionReadable}`);
}

// Drive the badge end to end through its real channels: storage.session for
// the tab being read, a status broadcast for playback state.
const swWorker = await (
  await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().includes('background.js'),
    { timeout: 5000 },
  )
).worker();
const readBadge = () =>
  reader.evaluate(() => ({
    hidden: document.getElementById('bg-badge').hidden,
    text: document.getElementById('bg-badge').textContent,
    eyebrow: document.getElementById('eyebrow').textContent,
    interactive: document.getElementById('head').hasAttribute('role'),
  }));

// Another tab is being read and the player is speaking → badge + click target.
await swWorker.evaluate(() => chrome.storage.session.set({ readingTab: { tabId: 999999 } }));
await swWorker.evaluate(() =>
  chrome.runtime.sendMessage({
    target: 'ui',
    type: 'status',
    status: { state: 'speaking', modelId: null },
  }),
);
await new Promise((r) => setTimeout(r, 600));
const backgrounded = await readBadge();
console.log('badge while backgrounded:', backgrounded);
if (backgrounded.hidden) errors.push('badge should show while another tab is being read');
if (!backgrounded.interactive) errors.push('header should be clickable while backgrounded');

// That tab closes → explained stop, no longer a click target.
await swWorker.evaluate(() =>
  chrome.storage.session.set({ readingTab: { tabId: null, reason: 'tab-closed' } }),
);
await new Promise((r) => setTimeout(r, 600));
const closed = await readBadge();
console.log('badge after tab close:', closed);
if (closed.hidden) errors.push('badge should explain a tab-close stop');
if (closed.interactive) errors.push('header must not be clickable once the tab is gone');
if (closed.eyebrow !== 'STOPPED') errors.push(`eyebrow should read STOPPED, got ${closed.eyebrow}`);

await swWorker.evaluate(() => chrome.storage.session.remove('readingTab'));

// -- Spacebar transport ------------------------------------------------------
// The key wiring is DOM-bound, so unit tests can't reach it. Watch the command
// cross the real runtime channel instead: record player-cmd in the worker,
// drive a status in, press the key, read back what arrived.
await swWorker.evaluate(() => {
  globalThis.__cmds = [];
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === 'background' && msg.type === 'player-cmd') globalThis.__cmds.push(msg.cmd.type);
  });
});

await reader.bringToFront();

/** Put the view in `state`, focus `selector` (or nothing), tap space, and
 *  return the commands the background saw. */
async function spaceWith(state, selector = null) {
  await swWorker.evaluate(
    (s) =>
      chrome.runtime.sendMessage({
        target: 'ui',
        type: 'status',
        status: { state: s, modelId: null },
      }),
    state,
  );
  await new Promise((r) => setTimeout(r, 300));
  await swWorker.evaluate(() => {
    globalThis.__cmds = [];
  });
  await reader.evaluate((sel) => {
    document.activeElement?.blur?.();
    if (sel) document.querySelector(sel)?.focus();
  }, selector);
  await reader.keyboard.press('Space');
  await new Promise((r) => setTimeout(r, 400));
  return swWorker.evaluate(() => globalThis.__cmds);
}

const spaceSpeaking = await spaceWith('speaking');
console.log('space while speaking:', spaceSpeaking);
if (!spaceSpeaking.includes('pause')) {
  errors.push(`space while speaking should pause, got ${JSON.stringify(spaceSpeaking)}`);
}

const spacePaused = await spaceWith('paused');
console.log('space while paused:', spacePaused);
if (!spacePaused.includes('resume')) {
  errors.push(`space while paused should resume, got ${JSON.stringify(spacePaused)}`);
}

// A focused control keeps the key the browser already gave it.
const spaceOnStop = await spaceWith('speaking', '#stop');
console.log('space with Stop focused:', spaceOnStop);
if (!spaceOnStop.includes('stop')) {
  errors.push(`space on a focused Stop should stop, got ${JSON.stringify(spaceOnStop)}`);
}
if (spaceOnStop.includes('pause')) {
  errors.push('space must not pause when a control owns the key');
}

// Nothing playing → the key is left alone entirely.
const spaceIdle = await spaceWith('idle');
console.log('space while idle:', spaceIdle);
if (spaceIdle.length > 0) {
  errors.push(`space while idle should send nothing, got ${JSON.stringify(spaceIdle)}`);
}

// Clicking Pause focuses it, then the status change hides it. Space must still
// resume — this is the ordinary mouse-then-keyboard path.
await swWorker.evaluate(() =>
  chrome.runtime.sendMessage({
    target: 'ui',
    type: 'status',
    status: { state: 'speaking', modelId: null },
  }),
);
await new Promise((r) => setTimeout(r, 300));
await reader.click('#pause');
await swWorker.evaluate(() =>
  chrome.runtime.sendMessage({
    target: 'ui',
    type: 'status',
    status: { state: 'paused', modelId: null },
  }),
);
await new Promise((r) => setTimeout(r, 300));
await swWorker.evaluate(() => {
  globalThis.__cmds = [];
});
await reader.keyboard.press('Space');
await new Promise((r) => setTimeout(r, 400));
const afterClickPause = await swWorker.evaluate(() => globalThis.__cmds);
console.log('space after clicking Pause:', afterClickPause);
if (!afterClickPause.includes('resume')) {
  errors.push(`space after clicking Pause should resume, got ${JSON.stringify(afterClickPause)}`);
}

// -- Scroll idle → return to the line being read -----------------------------
// The regression this guards: the centring scroll used to live inside
// setActiveLine, which early-returns on an unchanged index, so scrolling away
// mid-chunk stranded the view until the player crossed a chunk boundary.
await reader.setViewport({ width: 420, height: 700 });
const lyricsTop = () => reader.evaluate(() => document.getElementById('lyrics').scrollTop);

const setReadingState = (state, chunkIndex) =>
  swWorker.evaluate(
    (s, i) =>
      chrome.runtime.sendMessage({
        target: 'ui',
        type: 'status',
        status: { state: s, modelId: null, chunkIndex: i, chunkCount: 60 },
      }),
    state,
    chunkIndex,
  );

await swWorker.evaluate(
  (chunks) =>
    chrome.runtime.sendMessage({
      target: 'ui',
      type: 'transcript',
      chunks,
      title: 'Scroll follow test',
    }),
  Array.from({ length: 60 }, (_, i) => `Transcript line number ${i}, long enough to wrap a little.`),
);
await setReadingState('speaking', 30);
await new Promise((r) => setTimeout(r, 1500));
const centred = await lyricsTop();
console.log('scroll centred on the active line:', centred);
if (centred <= 0) errors.push(`expected the active line to be scrolled into view, got ${centred}`);

// Scroll away without touching the active index — same event a scrollbar drag
// or PageDown produces.
await reader.evaluate(() => {
  document.getElementById('lyrics').scrollTop = 0;
});
await new Promise((r) => setTimeout(r, 500));
const scrolledAway = await lyricsTop();
if (scrolledAway > 20) errors.push(`expected the view to stay scrolled away, got ${scrolledAway}`);

// FOLLOW_RESUME_MS is 6s; allow the smooth scroll to land.
await new Promise((r) => setTimeout(r, 7500));
const returned = await lyricsTop();
console.log('scroll after 6s idle:', returned);
if (Math.abs(returned - centred) > 40) {
  errors.push(`expected a return to ~${centred} after idle, got ${returned}`);
}

// A finished read must not yank you back — scrolling it is how you re-read.
await setReadingState('idle', 30);
await new Promise((r) => setTimeout(r, 300));
await reader.evaluate(() => {
  document.getElementById('lyrics').scrollTop = 0;
});
await new Promise((r) => setTimeout(r, 7500));
const idleScroll = await lyricsTop();
console.log('scroll after 6s idle on a finished read:', idleScroll);
if (idleScroll > 20) {
  errors.push(`a finished read must not scroll itself back, got ${idleScroll}`);
}

// --- Call-to-action cards --------------------------------------------------
// Served over http rather than data:/file: because <all_urls> is what grants
// the panel its access, and neither of those schemes is covered by it.
const FIXTURE_TITLE = 'Fixture article for MelonSpeak';
const fixtureServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html><head><title>${FIXTURE_TITLE}</title></head><body>` +
      `<p id="para">Every day afternoon I have at least one build running somewhere.</p>` +
      `</body></html>`,
  );
});
await new Promise((r) => fixtureServer.listen(0, '127.0.0.1', r));
const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/`;

// The scroll checks above left a 60-line transcript behind, which would put
// the cards in their compact form. Clear it for the no-transcript case.
await swWorker.evaluate(() =>
  chrome.runtime.sendMessage({ target: 'ui', type: 'transcript', chunks: [], title: '' }),
);
await swWorker.evaluate(() =>
  chrome.runtime.sendMessage({
    target: 'ui',
    type: 'status',
    status: { state: 'idle', modelId: null },
  }),
);

const fixture = await browser.newPage();
pageErrors(fixture, 'fixture');
await fixture.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
// Highlight before the panel starts watching, so this also covers the
// watcher reporting a selection that predates it.
await fixture.evaluate(() => {
  const range = document.createRange();
  range.selectNodeContents(document.getElementById('para'));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
// The reading view tracks the active tab of its own window, so the fixture
// has to actually be the front tab — the view keeps running in the background.
await fixture.bringToFront();
await new Promise((r) => setTimeout(r, 1200));

const cards = await reader.evaluate(() => ({
  ctaHidden: document.getElementById('cta').hidden,
  full: document.getElementById('cta').classList.contains('full'),
  pageSub: document.getElementById('cta-page-sub').textContent.trim(),
  pageDisabled: document.getElementById('cta-page').disabled,
  selectionDormant: document.getElementById('cta-selection').classList.contains('dormant'),
  selectionDisabled: document.getElementById('cta-selection').disabled,
  quote: document.getElementById('cta-selection-quote').textContent.trim(),
  meta: document.getElementById('cta-selection-meta').textContent.trim(),
  replayHidden: document.getElementById('cta-replay').hidden,
}));
console.log('cta cards with a highlight on the active tab:', cards);
await reader.screenshot({ path: join(OUT, 'reader-cta.png') });

if (cards.ctaHidden) errors.push('cards should be showing with nothing being read');
if (!cards.full) errors.push('cards should be full-size with no transcript');
if (cards.pageDisabled) errors.push('read-page card should be enabled on an http page');
if (cards.pageSub !== FIXTURE_TITLE) {
  errors.push(`read-page card should name the active tab, got "${cards.pageSub}"`);
}
if (cards.selectionDormant || cards.selectionDisabled) {
  errors.push('highlight card should light up when the page has a selection');
}
if (!cards.quote.includes('Every day afternoon')) {
  errors.push(`highlight card should quote the selection, got "${cards.quote}"`);
}
if (!/^11 words · /.test(cards.meta)) {
  errors.push(`highlight card should count the selected words, got "${cards.meta}"`);
}
if (!cards.replayHidden) errors.push('replay card must not offer to repeat a read that never happened');

// Clearing the highlight must put the card back to sleep.
await fixture.evaluate(() => window.getSelection().removeAllRanges());
await new Promise((r) => setTimeout(r, 800));
const afterClear = await reader.evaluate(() => ({
  dormant: document.getElementById('cta-selection').classList.contains('dormant'),
  quoteHidden: document.getElementById('cta-selection-quote').hidden,
}));
console.log('highlight card after clearing the selection:', afterClear);
if (!afterClear.dormant) errors.push('highlight card should go dormant when the selection clears');
if (!afterClear.quoteHidden) errors.push('a cleared selection must not leave its quote on screen');

// A finished read: transcript kept, cards tucked underneath, replay offered.
await swWorker.evaluate(() =>
  chrome.runtime.sendMessage({
    target: 'ui',
    type: 'transcript',
    chunks: ['First chunk.', 'Second chunk.'],
    title: 'Test article',
  }),
);
await swWorker.evaluate(() =>
  chrome.runtime.sendMessage({
    target: 'ui',
    type: 'status',
    status: { state: 'idle', modelId: null },
  }),
);
await new Promise((r) => setTimeout(r, 800));
const finished = await reader.evaluate(() => ({
  compact: document.getElementById('cta').classList.contains('compact'),
  lyricsVisible: !document.getElementById('lyrics').hidden,
  replayHidden: document.getElementById('cta-replay').hidden,
  replaySub: document.getElementById('cta-replay-sub').textContent.trim(),
  eyebrow: document.getElementById('eyebrow').textContent,
}));
console.log('cta cards after a finished read:', finished);
await reader.screenshot({ path: join(OUT, 'reader-cta-finished.png') });
if (!finished.compact) errors.push('cards should be compact under a finished transcript');
if (!finished.lyricsVisible) errors.push('a finished read must keep its transcript on screen');
if (finished.replayHidden) errors.push('replay card should be offered once a read has finished');
// Not the title: the header already carries that, and so may the page card.
if (finished.replaySub !== 'From the top · 2 lines') {
  errors.push(`replay card should describe the transcript, got "${finished.replaySub}"`);
}
if (finished.eyebrow !== 'FINISHED') {
  errors.push(`eyebrow should read FINISHED, got ${finished.eyebrow}`);
}

await fixture.close();
fixtureServer.close();

if (DO_DOWNLOAD) {
  console.log('\n--- e2e: downloading ${MODEL} and synthesizing ---');
  // Track player status broadcasts from the onboarding page.
  await onboarding.bringToFront();
  await onboarding.evaluate(() => {
    window.__statuses = [];
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.target === 'ui' && msg.type === 'status') window.__statuses.push(msg.status);
    });
  });
  // Select only Piper, then download.
  await onboarding.evaluate((idx) => {
    document.querySelectorAll('.card input[type=checkbox]').forEach((cb, i) => {
      cb.checked = i === idx;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    document.getElementById('download').click();
  }, MODEL_INDEX);
  const t0 = Date.now();
  for (;;) {
    const state = await cardState(onboarding, MODEL_INDEX);
    if (state.error) {
      errors.push(`${MODEL} download failed: ${state.error}`);
      break;
    }
    if (state.installedVisible) {
      console.log(`${MODEL} downloaded+installed in ${Math.round((Date.now() - t0) / 1000)}s`);
      break;
    }
    if (Date.now() - t0 > 600_000) {
      errors.push(`${MODEL} download timed out (last: ${state.pct})`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await onboarding.screenshot({ path: join(OUT, 'onboarding-downloaded.png') });

  // "Installed" must mean the bytes are on disk, not that a flag was set.
  const stored = await inspectStorage(onboarding);
  const problems = storageProblems(MODEL, stored);
  console.log(`stored ${MB(stored.usage)}:`, problems.length ? problems : 'all files present');
  for (const p of problems) errors.push(`${MODEL} claims installed but ${p}`);

  if (!errors.some((e) => e.startsWith(MODEL))) {
    // Play the sample and watch for speaking → idle.
    await onboarding.evaluate((idx) => {
      document.querySelectorAll('.card')[idx].querySelector('.try').click();
    }, MODEL_INDEX);
    const t1 = Date.now();
    let sawSpeaking = false;
    let sawIdleAfter = false;
    let lastErr = null;
    while (Date.now() - t1 < 180_000) {
      const statuses = await onboarding.evaluate(() => window.__statuses);
      sawSpeaking = statuses.some((s) => s.state === 'speaking');
      lastErr = statuses.findLast?.((s) => s.state === 'error')?.detail ?? null;
      if (sawSpeaking && statuses.at(-1)?.state === 'idle') {
        sawIdleAfter = true;
        break;
      }
      if (lastErr) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('sample synthesis: speaking =', sawSpeaking, ', finished =', sawIdleAfter);
    if (lastErr) errors.push(`player error during sample: ${lastErr}`);
    else if (!sawSpeaking) errors.push('sample never reached speaking state');
  }

  // --- acceleration beta --------------------------------------------------
  if (DO_ACCEL && !errors.some((e) => e.startsWith(MODEL))) {
    console.log('\n--- e2e: accelerated synthesis (beta toggle) ---');
    // Every extension page carries the COEP/COOP manifest keys, so isolation
    // here implies the offscreen player (and the worker it spawns) has it.
    const isolated = await onboarding.evaluate(() => ({
      crossOriginIsolated,
      sab: typeof SharedArrayBuffer === 'function',
    }));
    console.log('extension page isolation:', JSON.stringify(isolated));
    if (!isolated.crossOriginIsolated || !isolated.sab) {
      errors.push('extension pages not crossOriginIsolated — COEP/COOP manifest keys ineffective');
    }
    await onboarding.evaluate(() => {
      window.__statuses = [];
      const t = document.getElementById('accel-toggle');
      t.checked = true;
      t.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 600)); // settings write + model-changed
    await onboarding.evaluate((idx) => {
      document.querySelectorAll('.card')[idx].querySelector('.try').click();
    }, MODEL_INDEX);
    const tA = Date.now();
    let accSpeaking = false;
    let accFinished = false;
    let accErr = null;
    let details = [];
    while (Date.now() - tA < 180_000) {
      const statuses = await onboarding.evaluate(() => window.__statuses);
      accSpeaking = statuses.some((s) => s.state === 'speaking');
      details = statuses.filter((s) => s.detail).map((s) => s.detail);
      accErr = statuses.findLast?.((s) => s.state === 'error')?.detail ?? null;
      if (accSpeaking && statuses.at(-1)?.state === 'idle') {
        accFinished = true;
        break;
      }
      if (accErr) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // The "(N threads)"/"(GPU)" suffix is computed inside the engine worker,
    // so seeing it proves isolation reached the worker and the engine took
    // the accelerated path — not just that a flag was set.
    const accelDetail = details.find((d) => / threads\)|\(GPU\)/.test(d)) ?? null;
    console.log(
      'accelerated sample: speaking =', accSpeaking,
      ', finished =', accFinished,
      ', mode =', accelDetail,
    );
    if (accErr) errors.push(`player error during accelerated sample: ${accErr}`);
    else if (!accSpeaking) errors.push('accelerated sample never reached speaking');
    else if (!accelDetail) {
      errors.push('acceleration on, but the engine loaded without threads/GPU');
    }
    // Restore the default for the flows that follow.
    await onboarding.evaluate(() => {
      const t = document.getElementById('accel-toggle');
      t.checked = false;
      t.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // --- uninstall ----------------------------------------------------------
  console.log(`\n--- e2e: removing ${MODEL} ---`);
  await clickRemove(onboarding, MODEL_INDEX);
  const tRemove = Date.now();
  let removedState = await cardState(onboarding, MODEL_INDEX);
  while (removedState.installedVisible && Date.now() - tRemove < 60_000) {
    await new Promise((r) => setTimeout(r, 500));
    removedState = await cardState(onboarding, MODEL_INDEX);
  }
  if (removedState.installedVisible) {
    errors.push(`${MODEL} still shows as installed after Remove (${removedState.error ?? ''})`);
  }
  const afterRemove = await inspectStorage(onboarding);
  console.log(`after remove: ${MB(afterRemove.usage)} left on disk`);
  if (isStored(MODEL, afterRemove)) errors.push(`${MODEL} files survived Remove`);
  await onboarding.screenshot({ path: join(OUT, 'onboarding-removed.png') });

  const panelAfter = await openPage('reader/reader.html', 'panel-after-remove');
  const backToSetup = await panelAfter.$eval('#setup-actions', (el) => !el.hidden);
  console.log('panel returns to setup prompt after removing the last model:', backToSetup);
  if (!backToSetup) errors.push('panel still offers a read after the last model was removed');
}

await browser.close();
if (errors.length) {
  console.error('\nSMOKE FAILURES:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('\nSMOKE OK');

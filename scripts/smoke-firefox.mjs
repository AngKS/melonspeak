// Firefox counterpart of smoke.mjs: loads dist/firefox into a real Firefox and
// verifies the onboarding surface, and with --download the full
// download → stored on disk → synthesize → uninstall cycle.
//
// Firefox specifics this harness works around:
// - WebDriver BiDi refuses to navigate a tab to moz-extension://, so we drive
//   the onboarding tab the background script opens on install, and identify it
//   by evaluated location.href (BiDi reports its URL as "about:blank").
// - page.reload()/goto never resolve for extension pages; don't use them.
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MB,
  cardState,
  clickRemove,
  inspectStorage,
  isStored,
  storageProblems,
} from './storage-probe.mjs';

const FIREFOX = process.env.FIREFOX_BIN ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const EXT = resolve('dist/firefox');
const OUT = process.env.SMOKE_OUT ?? 'dist/smoke-firefox';
const DO_DOWNLOAD = process.argv.includes('--download');
const MODEL = process.argv.find((a) => a.startsWith('--model='))?.slice(8) ?? 'piper';
const MODEL_INDEX = { kokoro: 0, supertonic: 1, piper: 2 }[MODEL];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: FIREFOX,
  headless: true,
  userDataDir: join(OUT, 'profile'),
  extraPrefsFirefox: { 'xpinstall.signatures.required': false },
});

const errors = [];

// BiDi cannot navigate to moz-extension:// pages, so the sidebar itself can't
// be driven here — but the wiring that makes the toolbar button open it is a
// static fact of the manifest, and that much is worth asserting.
{
  const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
  if (manifest.action.default_popup) {
    errors.push('action still declares a default_popup; the toolbar button must open the sidebar');
  }
  if (manifest.sidebar_action?.default_panel !== 'reader/reader.html') {
    errors.push('sidebar_action no longer points at the reading view');
  }
}

await browser.installExtension(EXT);

// The background script opens onboarding itself on install.
let onboarding;
for (let i = 0; i < 60 && !onboarding; i++) {
  for (const page of await browser.pages()) {
    const href = await page.evaluate(() => location.href).catch(() => '');
    if (href.includes('onboarding.html')) onboarding = page;
  }
  if (!onboarding) await new Promise((r) => setTimeout(r, 500));
}
if (!onboarding) {
  console.error('the onboarding tab never opened — the background page failed to start');
  await browser.close();
  process.exit(1);
}
onboarding.on('pageerror', (err) => errors.push(`[onboarding] pageerror: ${err.message}`));
onboarding.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[onboarding] console.error: ${msg.text()}`);
});

const cardCount = await onboarding.$$eval('.card', (els) => els.length);
console.log('onboarding cards:', cardCount);
if (cardCount !== 3) errors.push(`expected 3 model cards, got ${cardCount}`);

for (let i = 0; i < cardCount; i++) {
  const state = await cardState(onboarding, i);
  if (state.installedVisible) errors.push(`card ${i} shows "Installed" on a fresh profile`);
  if (state.progressVisible) errors.push(`card ${i} shows a progress bar before downloading`);
}
await onboarding.screenshot({ path: join(OUT, 'onboarding.png'), fullPage: true });

if (DO_DOWNLOAD) {
  console.log(`\n--- e2e: downloading ${MODEL} ---`);
  await onboarding.evaluate(() => {
    window.__statuses = [];
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.target === 'ui' && msg.type === 'status') window.__statuses.push(msg.status);
    });
  });
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

  const stored = await inspectStorage(onboarding);
  const problems = storageProblems(MODEL, stored);
  console.log(`stored ${MB(stored.usage)}:`, problems.length ? problems : 'all files present');
  for (const p of problems) errors.push(`${MODEL} claims installed but ${p}`);
  await onboarding.screenshot({ path: join(OUT, 'onboarding-downloaded.png'), fullPage: true });

  if (!errors.some((e) => e.startsWith(MODEL))) {
    // Synthesis has to come off local files: a phantom install still "works"
    // by silently re-downloading, so this alone would not catch it.
    await onboarding.evaluate((idx) => {
      window.__statuses = [];
      document.querySelectorAll('.card')[idx].querySelector('.try').click();
    }, MODEL_INDEX);
    const t1 = Date.now();
    let sawSpeaking = false;
    let lastErr = null;
    while (Date.now() - t1 < 180_000) {
      const statuses = await onboarding.evaluate(() => window.__statuses);
      sawSpeaking = statuses.some((s) => s.state === 'speaking');
      lastErr = statuses.findLast?.((s) => s.state === 'error')?.detail ?? null;
      if (sawSpeaking || lastErr) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('sample synthesis: speaking =', sawSpeaking);
    if (lastErr) errors.push(`player error during sample: ${lastErr}`);
    else if (!sawSpeaking) errors.push('sample never reached speaking state');
  }

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
  await onboarding.screenshot({ path: join(OUT, 'onboarding-removed.png'), fullPage: true });
}

await browser.close();
if (errors.length) {
  console.error('\nFIREFOX SMOKE FAILURES:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('\nFIREFOX SMOKE OK');

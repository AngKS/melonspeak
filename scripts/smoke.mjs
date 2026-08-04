// Loads the built extension into a real (headless) Chrome and verifies the
// surfaces boot without errors. With --download it also downloads the Piper
// model and runs a real end-to-end synthesis check.
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME_BIN ?? '.chrome-for-testing/chrome/mac_arm-151.0.7922.71/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const EXT = resolve('dist/chrome');
const OUT = process.env.SMOKE_OUT ?? 'dist/smoke';
const DO_DOWNLOAD = process.argv.includes('--download');
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
const sizesShown = await onboarding.$$eval('.real', (els) => els.map((e) => e.textContent.trim()));
console.log('model lines:', sizesShown);

const popup = await openPage('popup/popup.html', 'popup');
const setupVisible = await popup.$eval('#setup', (el) => !el.hidden);
console.log('popup shows setup prompt (no models yet):', setupVisible);
if (!setupVisible && FRESH) errors.push('popup should show setup prompt on a fresh profile');

await openPage('reader/reader.html', 'reader');

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
    const state = await onboarding.evaluate((idx) => {
      const cards = [...document.querySelectorAll('.card')];
      const c = cards[idx];
      return {
        installed: !c.querySelector('.installed').hidden,
        error: c.querySelector('.dl-error').hidden ? null : c.querySelector('.dl-error').textContent,
        pct: c.querySelector('.pct')?.textContent,
      };
    }, MODEL_INDEX);
    if (state.error) {
      errors.push(`${MODEL} download failed: ${state.error}`);
      break;
    }
    if (state.installed) {
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
}

await browser.close();
if (errors.length) {
  console.error('\nSMOKE FAILURES:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('\nSMOKE OK');

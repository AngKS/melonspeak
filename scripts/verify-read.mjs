// Verifies the real "Read page" flow: content-script extraction on a live
// website → chunking → synthesis → playback, and captures the Now Reading
// view mid-read. Requires a profile where a model is already installed
// (run smoke.mjs --download first).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { cpSync, rmSync } from 'node:fs';

const CHROME =
  '.chrome-for-testing/chrome/mac_arm-151.0.7922.71/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const OUT = process.env.SMOKE_OUT ?? 'dist/smoke';

// activeTab can't be granted programmatically, so test with an explicit host
// permission on a copy of the build — the only delta from production.
const TEST_EXT = join(OUT, 'ext-host-test');
rmSync(TEST_EXT, { recursive: true, force: true });
cpSync('dist/chrome', TEST_EXT, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(join(TEST_EXT, 'manifest.json')));
manifest.host_permissions = ['https://example.com/*'];
fs.writeFileSync(join(TEST_EXT, 'manifest.json'), JSON.stringify(manifest));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    `--disable-extensions-except=${resolve(TEST_EXT)}`,
    `--load-extension=${resolve(TEST_EXT)}`,
    '--no-first-run',
  ],
  userDataDir: join(OUT, 'profile-read'),
});
const errors = [];

const swTarget = await browser.waitForTarget(
  (t) => t.type() === 'service_worker' && t.url().includes('background.js'),
  { timeout: 15000 },
);
const extId = new URL(swTarget.url()).host;

// Status listener page.
const monitor = await browser.newPage();
await monitor.goto(`chrome-extension://${extId}/onboarding/onboarding.html`, {
  waitUntil: 'networkidle0',
});
await monitor.evaluate(() => {
  window.__statuses = [];
  window.__downloads = [];
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === 'ui' && msg.type === 'status') window.__statuses.push(msg.status);
    if (msg?.target === 'ui' && msg.type === 'download-progress') window.__downloads.push(msg.progress);
  });
});

// Install Piper into this fresh profile first.
await monitor.evaluate(() => {
  chrome.runtime.sendMessage({ target: 'background', type: 'player-cmd', cmd: { type: 'download', modelIds: ['piper'] } });
});
const tD = Date.now();
for (;;) {
  const dls = await monitor.evaluate(() => window.__downloads);
  const done = dls.find((d) => d.done);
  if (done?.error) { console.error('piper install failed:', done.error); process.exit(1); }
  if (done) { console.log('piper installed for read test'); break; }
  if (Date.now() - tD > 300000) { console.error('piper install timeout'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1500));
}

// A real website to read.
const site = await browser.newPage();
await site.goto('https://example.com', { waitUntil: 'networkidle0' });
await site.bringToFront();

await monitor.evaluate(() => {
  chrome.runtime.sendMessage({ target: 'background', type: 'read-page' });
});

let speakingStatus = null;
const t0 = Date.now();
while (Date.now() - t0 < 120_000) {
  const statuses = await monitor.evaluate(() => window.__statuses);
  speakingStatus = statuses.find((s) => s.state === 'speaking') ?? null;
  const err = statuses.find((s) => s.state === 'error');
  if (err) {
    errors.push(`read-page errored: ${err.detail}`);
    break;
  }
  if (speakingStatus) break;
  await new Promise((r) => setTimeout(r, 1000));
}
if (!speakingStatus && !errors.length) errors.push('read-page never reached speaking');
console.log('speaking status:', JSON.stringify(speakingStatus));
if (speakingStatus && !/example/i.test(speakingStatus.title ?? '')) {
  errors.push(`unexpected title: ${speakingStatus.title}`);
}

// Capture the Now Reading view mid-read.
const reader = await browser.newPage();
await reader.goto(`chrome-extension://${extId}/reader/reader.html`, {
  waitUntil: 'networkidle0',
});
await new Promise((r) => setTimeout(r, 2500));
await reader.screenshot({ path: join(OUT, 'reader-live.png') });
const lyricsState = await reader.evaluate(() => ({
  lines: document.querySelectorAll('.line').length,
  active: document.querySelector('.line.active')?.textContent?.slice(0, 60) ?? null,
  transportVisible: !document.getElementById('reading-actions').hidden,
}));
console.log('reader state:', JSON.stringify(lyricsState));
if (lyricsState.lines === 0) errors.push('reader shows no transcript lines');
if (!lyricsState.active) errors.push('reader has no active line');
if (!lyricsState.transportVisible) errors.push('reader transport not visible while speaking');

// A panel opened mid-read must catch up to the read already in progress —
// this is what the popup used to prove, and the panel is the only surface now.
const late = await browser.newPage();
await late.goto(`chrome-extension://${extId}/reader/reader.html`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1500));
await late.screenshot({ path: join(OUT, 'panel-live.png') });
const lateState = await late.evaluate(() => ({
  transportVisible: !document.getElementById('reading-actions').hidden,
  title: document.getElementById('title')?.textContent,
  lines: document.querySelectorAll('.line').length,
}));
console.log('late panel state:', JSON.stringify(lateState));
if (!lateState.transportVisible) errors.push('panel opened mid-read shows no transport');
if (!lateState.lines) errors.push('panel opened mid-read shows no transcript');

// A preparing status must have been broadcast before speaking started.
const sawPreparing = await monitor.evaluate(() =>
  window.__statuses.some((s) => s.state === 'preparing'),
);
console.log('saw preparing state:', sawPreparing);
if (!sawPreparing) errors.push('no preparing status was broadcast before speaking');

// Click-to-jump: click the first line; whether the read is still going or
// already finished, playback must land on chunk 0 of a transcript.
const statusMark = await monitor.evaluate(() => window.__statuses.length);
await reader.evaluate(() => document.querySelector('.line').click());
const tSeek = Date.now();
let jumped = false;
while (Date.now() - tSeek < 45000) {
  jumped = await monitor.evaluate(
    (mark) =>
      window.__statuses.slice(mark).some((s) => s.state === 'speaking' && s.chunkIndex === 0),
    statusMark,
  );
  if (jumped) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log('click-to-jump reached chunk 0:', jumped);
if (!jumped) errors.push('clicking a transcript line did not move playback there');

// Stop and confirm idle.
await monitor.evaluate(() => {
  chrome.runtime.sendMessage({ target: 'background', type: 'player-cmd', cmd: { type: 'stop' } });
});
await new Promise((r) => setTimeout(r, 1500));
const last = await monitor.evaluate(() => window.__statuses.at(-1));
console.log('after stop:', JSON.stringify(last));
if (last?.state !== 'idle') errors.push(`stop did not reach idle (got ${last?.state})`);

await browser.close();
if (errors.length) {
  console.error('\nREAD-PAGE FAILURES:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('\nREAD-PAGE OK');

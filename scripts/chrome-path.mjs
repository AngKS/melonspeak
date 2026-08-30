// Locates the Chrome for Testing binary the browser-driving scripts need.
//
// Branded Chrome >= 137 removed --load-extension, so every harness here runs
// against Chrome for Testing. Its install path carries the exact version
// (chrome/mac_arm-151.0.7922.71/...), which is why three scripts had that
// string baked in and drifted out of date the first time it was reinstalled:
// resolve it at run time instead, newest install first.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = '.chrome-for-testing/chrome';

/** Executable inside one downloaded platform directory, per platform. */
const CANDIDATES = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-linux64/chrome',
  'chrome-win64/chrome.exe',
];

/**
 * Absolute path to a usable Chrome for Testing binary.
 * CHROME_BIN wins; otherwise the newest install under .chrome-for-testing.
 * Throws with the install command rather than letting puppeteer fail with a
 * bare ENOENT on a path the caller never chose.
 */
export function chromePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  let versions = [];
  try {
    // Reverse lexical order approximates newest-first for the
    // <platform>-<major>.<minor>.<build>.<patch> naming, and any install that
    // works is acceptable — this only picks which of several to prefer.
    versions = readdirSync(ROOT).sort().reverse();
  } catch {
    // No .chrome-for-testing at all; fall through to the error below.
  }
  for (const version of versions) {
    for (const candidate of CANDIDATES) {
      const full = resolve(join(ROOT, version, candidate));
      if (existsSync(full)) return full;
    }
  }
  throw new Error(
    `No Chrome for Testing found under ${ROOT}/. Install one with:\n` +
      `  npx @puppeteer/browsers install chrome@stable --path .chrome-for-testing\n` +
      `or point CHROME_BIN at a binary that still supports --load-extension.`,
  );
}

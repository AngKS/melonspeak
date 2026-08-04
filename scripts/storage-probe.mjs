// Shared by the Chrome and Firefox smoke tests: an independent view of what a
// model actually left on disk.
//
// Deliberately does NOT use the extension's own engines/model-storage module —
// the point is to catch it (or a library) claiming an install that isn't there,
// which is exactly how "✓ Installed" came to be shown for models whose weights
// were never written.

const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_VOICES = [
  'af_heart',
  'af_bella',
  'af_nicole',
  'am_michael',
  'am_fenrir',
  'am_puck',
  'bf_emma',
  'bm_george',
  'bm_fable',
];
const SUPERTONIC_FILES = [
  'onnx/duration_predictor.onnx',
  'onnx/text_encoder.onnx',
  'onnx/vector_estimator.onnx',
  'onnx/vocoder.onnx',
  'onnx/tts.json',
  'onnx/unicode_indexer.json',
  'voice_styles/F1.json',
  'voice_styles/M1.json',
];
const PIPER_MODEL_FILE = 'piper/en_US-hfc_female-medium.onnx';
const PIPER_CONFIG_FILE = 'piper/en_US-hfc_female-medium.onnx.json';

/** Reads Cache API + OPFS + quota usage from an extension page. */
export async function inspectStorage(page) {
  return page.evaluate(async () => {
    const out = { caches: {}, opfs: [], usage: 0, errors: [] };
    try {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        out.caches[name] = (await cache.keys()).map((req) => req.url);
      }
    } catch (err) {
      out.errors.push(`caches: ${err.message}`);
    }
    try {
      const walk = async (dir, prefix) => {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === 'file') {
            out.opfs.push({ path: prefix + name, size: (await handle.getFile()).size });
          } else {
            await walk(handle, `${prefix}${name}/`);
          }
        }
      };
      await walk(await navigator.storage.getDirectory(), '');
    } catch (err) {
      out.errors.push(`opfs: ${err.message}`);
    }
    try {
      out.usage = (await navigator.storage.estimate()).usage ?? 0;
    } catch {
      /* not all browsers expose it */
    }
    return out;
  });
}

/** Everything missing for `model` to work offline; empty means fully stored. */
export function storageProblems(model, storage) {
  const problems = [];
  const cached = (name) => storage.caches[name] ?? [];
  const opfs = (path) => storage.opfs.find((f) => f.path === path);

  if (model === 'piper') {
    const weights = opfs(PIPER_MODEL_FILE);
    if (!weights) problems.push(`missing ${PIPER_MODEL_FILE} in OPFS`);
    else if (weights.size < 50_000_000) {
      problems.push(`${PIPER_MODEL_FILE} truncated (${weights.size} bytes)`);
    }
    if (!opfs(PIPER_CONFIG_FILE)) problems.push(`missing ${PIPER_CONFIG_FILE} in OPFS`);
  }

  if (model === 'kokoro') {
    const weights = cached('transformers-cache').filter(
      (url) => url.includes(KOKORO_MODEL) && url.endsWith('.onnx'),
    );
    if (weights.length === 0) problems.push('missing Kokoro weights in transformers-cache');
    for (const voice of KOKORO_VOICES) {
      if (!cached('melonspeak-models').some((url) => url.endsWith(`/voices/${voice}.bin`))) {
        problems.push(`missing voice ${voice}`);
      }
    }
  }

  if (model === 'supertonic') {
    for (const file of SUPERTONIC_FILES) {
      if (!cached('melonspeak-models').some((url) => url.endsWith(file))) {
        problems.push(`missing ${file}`);
      }
    }
  }

  return problems;
}

export const isStored = (model, storage) => storageProblems(model, storage).length === 0;

export const MB = (bytes) => `${Math.round(bytes / 1e6)} MB`;

/** Drives the onboarding card's two-step Remove button. */
export async function clickRemove(page, index) {
  for (const _ of [1, 2]) {
    await page.evaluate((idx) => {
      document.querySelectorAll('.card')[idx].querySelector('.remove').click();
    }, index);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Card state as the user sees it — `hidden` alone lies when CSS overrides it. */
export async function cardState(page, index) {
  return page.evaluate((idx) => {
    const card = document.querySelectorAll('.card')[idx];
    const installed = card.querySelector('.installed');
    const error = card.querySelector('.dl-error');
    return {
      installedVisible: getComputedStyle(installed).display !== 'none',
      progressVisible: getComputedStyle(card.querySelector('.progress')).display !== 'none',
      error: getComputedStyle(error).display === 'none' ? null : error.textContent,
      pct: card.querySelector('.pct')?.textContent,
    };
  }, index);
}

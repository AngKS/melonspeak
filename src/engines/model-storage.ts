// The single source of truth for "is this model really on disk?" and for
// deleting it again.
//
// Deliberately storage-only — no engine, ONNX or WASM imports — so the popup
// and the onboarding page can ask without pulling in megabytes of inference
// code. Settings are a *record* of what was downloaded; the bytes on disk are
// the fact, and the two drift apart (interrupted download, evicted cache,
// cleared site data). Every "Installed" claim in the UI is checked here.
import type { ModelId } from '../lib/messages';
import type { RemoteFile } from './downloader';
import { allCached, removeCached } from './downloader';

/** Cache transformers.js writes Kokoro's weights into (its own name). */
const TRANSFORMERS_CACHE = 'transformers-cache';
/** Our cache: Supertonic's files and Kokoro's voice embeddings. */
const MODEL_CACHE = 'melonspeak-models';

// --- Kokoro ---------------------------------------------------------------

export const KOKORO_HF_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
/** Voices offered in the UI; all are prefetched so switching works offline. */
export const KOKORO_VOICE_IDS = [
  'af_heart',
  'af_bella',
  'af_nicole',
  'am_michael',
  'am_fenrir',
  'am_puck',
  'bf_emma',
  'bm_george',
  'bm_fable',
] as const;

export const kokoroVoiceUrl = (voice: string): string =>
  `https://huggingface.co/${KOKORO_HF_MODEL}/resolve/main/voices/${voice}.bin`;

// --- Supertonic -----------------------------------------------------------

export const SUPERTONIC_BASE = 'https://huggingface.co/Supertone/supertonic/resolve/main/';

export const SUPERTONIC_ONNX: RemoteFile[] = [
  { url: `${SUPERTONIC_BASE}onnx/duration_predictor.onnx`, bytes: 1_500_789 },
  { url: `${SUPERTONIC_BASE}onnx/text_encoder.onnx`, bytes: 27_348_373 },
  { url: `${SUPERTONIC_BASE}onnx/vector_estimator.onnx`, bytes: 132_471_364 },
  { url: `${SUPERTONIC_BASE}onnx/vocoder.onnx`, bytes: 101_405_066 },
];
const SUPERTONIC_ASSETS: RemoteFile[] = [
  { url: `${SUPERTONIC_BASE}onnx/tts.json`, bytes: 8_645 },
  { url: `${SUPERTONIC_BASE}onnx/unicode_indexer.json`, bytes: 262_134 },
  { url: `${SUPERTONIC_BASE}voice_styles/F1.json`, bytes: 420_622 },
  { url: `${SUPERTONIC_BASE}voice_styles/M1.json`, bytes: 421_053 },
];
export const SUPERTONIC_FILES = [...SUPERTONIC_ONNX, ...SUPERTONIC_ASSETS];

// --- Piper ----------------------------------------------------------------
// piper-tts-web keeps its voices in OPFS under piper/<file name>; we write and
// verify the same layout so its session loader finds them.

export const PIPER_VOICE_ID = 'en_US-hfc_female-medium';
const PIPER_DIR = 'piper';
export const PIPER_MODEL_FILE = `${PIPER_VOICE_ID}.onnx`;
export const PIPER_CONFIG_FILE = `${PIPER_VOICE_ID}.onnx.json`;
/** The weights are ~63 MB; anything much smaller is a truncated write. */
const PIPER_MIN_MODEL_BYTES = 50_000_000;

export async function piperDir(create = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(PIPER_DIR, { create });
  } catch {
    // No OPFS, or the directory doesn't exist yet.
    return null;
  }
}

async function piperFileSize(dir: FileSystemDirectoryHandle, name: string): Promise<number> {
  try {
    return (await (await dir.getFileHandle(name)).getFile()).size;
  } catch {
    return 0;
  }
}

// --- Installation state ---------------------------------------------------

/** True only when every file the model needs is present locally. */
export async function isInstalled(id: ModelId): Promise<boolean> {
  try {
    switch (id) {
      case 'kokoro':
        return await kokoroInstalled();
      case 'supertonic':
        return await allCached(SUPERTONIC_FILES);
      case 'piper':
        return await piperInstalled();
    }
  } catch {
    // Storage unavailable (private window, quota errors): treat as not
    // installed rather than promising offline playback we can't deliver.
    return false;
  }
}

async function kokoroInstalled(): Promise<boolean> {
  const weights = await caches.open(TRANSFORMERS_CACHE);
  const hasWeights = (await weights.keys()).some(
    (req) => req.url.includes(KOKORO_HF_MODEL) && req.url.endsWith('.onnx'),
  );
  if (!hasWeights) return false;
  // Voice embeddings are fetched separately; without them the voice picker
  // only works while online.
  const voices = await caches.open(MODEL_CACHE);
  for (const voice of KOKORO_VOICE_IDS) {
    if (!(await voices.match(kokoroVoiceUrl(voice)))) return false;
  }
  return true;
}

async function piperInstalled(): Promise<boolean> {
  const dir = await piperDir();
  if (!dir) return false;
  const [model, config] = await Promise.all([
    piperFileSize(dir, PIPER_MODEL_FILE),
    piperFileSize(dir, PIPER_CONFIG_FILE),
  ]);
  return model >= PIPER_MIN_MODEL_BYTES && config > 0;
}

/** Checks every model at once; used to reconcile settings with reality. */
export async function installedModels(ids: readonly ModelId[]): Promise<Record<string, boolean>> {
  const entries = await Promise.all(ids.map(async (id) => [id, await isInstalled(id)] as const));
  return Object.fromEntries(entries);
}

// --- Uninstall ------------------------------------------------------------

/** Deletes a model's local files. Safe to call when it isn't installed. */
export async function uninstall(id: ModelId): Promise<void> {
  switch (id) {
    case 'kokoro': {
      for (const name of [TRANSFORMERS_CACHE, MODEL_CACHE]) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) {
          if (req.url.includes(KOKORO_HF_MODEL)) await cache.delete(req);
        }
      }
      break;
    }
    case 'supertonic':
      await removeCached(SUPERTONIC_FILES);
      break;
    case 'piper': {
      const dir = await piperDir();
      if (!dir) break;
      // FileSystemFileHandle.remove() (what piper-tts-web calls) is Chrome-only
      // and fails silently on Firefox; removeEntry is the standard API.
      for (const file of [PIPER_MODEL_FILE, PIPER_CONFIG_FILE]) {
        await dir.removeEntry(file).catch(() => {});
      }
      break;
    }
  }
}

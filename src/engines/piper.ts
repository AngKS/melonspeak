// Piper TTS (en_US-hfc_female-medium) via @mintplex-labs/piper-tts-web.
// The model is cached in OPFS by the library; the espeak-ng phonemizer WASM
// and ONNX runtime are bundled inside the extension, so after the one-time
// model download everything runs offline.
import * as piper from '@mintplex-labs/piper-tts-web';
import * as ort from 'onnxruntime-web';
import { extUrl } from '../lib/ext-url';
import { decodeWav } from '../lib/wav';
import { downloadErrorMessage } from './downloader';
import { PIPER_CONFIG_FILE, PIPER_MODEL_FILE, PIPER_VOICE_ID, piperDir } from './model-storage';
import { wasmThreads } from './accel';
import type { EngineOptions, ProgressFn, TTSEngine } from './types';

const MODEL_BYTES = 63_201_294;

const WASM_PATHS = {
  onnxWasm: extUrl('wasm/ort/'),
  piperWasm: extUrl('wasm/piper/piper_phonemize.wasm'),
  piperData: extUrl('wasm/piper/piper_phonemize.data'),
};

export async function createEngine(
  onProgress?: (detail: string) => void,
  opts?: EngineOptions,
): Promise<TTSEngine> {
  const threads = wasmThreads(opts?.accel ?? false);
  // piper-tts-web sets env.wasm.numThreads = hardwareConcurrency
  // unconditionally during init (it shares this ort module instance), which
  // would make the beta toggle meaningless for this engine once the pages are
  // cross-origin isolated. Pinning the property keeps the toggle in charge.
  try {
    Object.defineProperty(ort.env.wasm, 'numThreads', {
      configurable: true,
      get: () => threads,
      set: () => {},
    });
  } catch {
    // Leave the library's default; threads still require isolation to engage.
  }
  const suffix = threads > 1 ? ` (${threads} threads)` : '';
  onProgress?.(`Loading Piper…${suffix}`);
  const session = await piper.TtsSession.create({
    voiceId: PIPER_VOICE_ID as Parameters<typeof piper.TtsSession.create>[0]['voiceId'],
    wasmPaths: WASM_PATHS,
    progress: (p) => {
      if (p.total) onProgress?.(`Loading Piper… ${Math.round((p.loaded / p.total) * 100)}%${suffix}`);
    },
  });
  return {
    async synthesize(text) {
      const wav = await session.predict(text);
      return decodeWav(await wav.arrayBuffer());
    },
    dispose() {
      // The library keeps a singleton; clear it so model memory can be freed.
      piper.TtsSession._instance = null;
    },
  };
}

export async function download(onProgress: ProgressFn): Promise<void> {
  const path = piper.PATH_MAP[PIPER_VOICE_ID as keyof typeof piper.PATH_MAP];
  const base = `${piper.HF_BASE}/${path}`;
  // Not piper.download(): it starts its OPFS write without awaiting it, so the
  // 63 MB write was still in flight when this worker got terminated on
  // completion and only the tiny config file survived — the model looked
  // installed and every read silently re-downloaded it.
  await streamToOpfs(base, PIPER_MODEL_FILE, MODEL_BYTES, onProgress);
  await streamToOpfs(`${base}.json`, PIPER_CONFIG_FILE);
  onProgress(MODEL_BYTES, MODEL_BYTES, PIPER_MODEL_FILE);
}

/** Streams one file into OPFS and resolves only once it is durably written. */
async function streamToOpfs(
  url: string,
  name: string,
  expectedBytes = 0,
  onProgress?: ProgressFn,
): Promise<void> {
  const dir = await piperDir(true);
  if (!dir) throw new Error('Local file storage is unavailable in this browser');
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(downloadErrorMessage(res.status, name));
  const total = Number(res.headers.get('Content-Length')) || expectedBytes;

  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  let loaded = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      loaded += value.byteLength;
      onProgress?.(Math.min(loaded, total), total, name);
    }
    await writable.close();
  } catch (err) {
    // A half-written file must not pass the installed check next time.
    await writable.abort().catch(() => {});
    await dir.removeEntry(name).catch(() => {});
    throw err;
  }
  const written = (await (await dir.getFileHandle(name)).getFile()).size;
  if (total > 0 && written !== total) {
    await dir.removeEntry(name).catch(() => {});
    throw new Error(`${name} was saved incompletely (${written} of ${total} bytes)`);
  }
}

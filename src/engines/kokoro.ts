// Kokoro-82M via kokoro-js / transformers.js (WASM, 8-bit quantized).
// Model weights are cached by transformers.js in the browser Cache API on
// first download; voice embeddings are captured by our HF fetch cache.
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import { extUrl } from '../lib/ext-url';
import { installHfFetchCache } from '../lib/hf-cache';
import type { ProgressFn, TTSEngine } from './types';

const HF_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DTYPE = 'q8';
/** Voices offered in the UI; prefetched at download time for offline use. */
export const VOICE_IDS = [
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

function configureTransformers(): void {
  installHfFetchCache();
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  // Serve the ONNX runtime WASM from inside the extension (never a CDN),
  // single-threaded: extension pages have no cross-origin isolation, so no
  // SharedArrayBuffer.
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    wasm.wasmPaths = extUrl('wasm/tjs/');
    wasm.numThreads = 1;
  }
}

interface TransformersProgress {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

async function loadModel(onProgress?: (p: TransformersProgress) => void): Promise<KokoroTTS> {
  configureTransformers();
  return KokoroTTS.from_pretrained(HF_MODEL, {
    dtype: DTYPE,
    device: 'wasm',
    progress_callback: onProgress as never,
  });
}

export async function createEngine(onProgress?: (detail: string) => void): Promise<TTSEngine> {
  const tts = await loadModel((p) => {
    if (p.status === 'progress' && p.total) {
      onProgress?.(`Loading Kokoro-82M… ${Math.round(((p.loaded ?? 0) / p.total) * 100)}%`);
    }
  });
  return {
    async synthesize(text, voice) {
      const audio = await tts.generate(text, { voice: (voice ?? 'af_heart') as never });
      return { samples: audio.audio, sampleRate: audio.sampling_rate };
    },
    dispose() {
      // kokoro-js exposes no explicit teardown; dropping the reference frees
      // the WASM session with the module scope.
    },
  };
}

export async function download(onProgress: ProgressFn): Promise<void> {
  const perFile = new Map<string, { loaded: number; total: number }>();
  const report = (activeFile?: string) => {
    let loaded = 0;
    let total = 0;
    for (const f of perFile.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    if (total > 0) onProgress(loaded, total, activeFile);
  };
  await loadModel((p) => {
    if (p.status === 'progress' && p.file && p.total) {
      perFile.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
      report(p.file);
    }
  });
  // Prefetch voice embeddings through the HF fetch cache so voice switching
  // works offline forever after.
  for (const voice of VOICE_IDS) {
    await fetch(`https://huggingface.co/${HF_MODEL}/resolve/main/voices/${voice}.bin`);
  }
  report();
}

const MODEL_URL_PREFIX = `https://huggingface.co/${HF_MODEL}/resolve/main/`;

export async function isDownloaded(): Promise<boolean> {
  try {
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    return keys.some((req) => req.url.includes(HF_MODEL) && req.url.endsWith('.onnx'));
  } catch {
    return false;
  }
}

export async function remove(): Promise<void> {
  for (const name of ['transformers-cache', 'melonspeak-models']) {
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      if (req.url.startsWith(MODEL_URL_PREFIX) || req.url.includes(HF_MODEL)) {
        await cache.delete(req);
      }
    }
  }
}

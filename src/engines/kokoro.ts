// Kokoro-82M via kokoro-js / transformers.js (WASM, 8-bit quantized).
// Model weights are cached by transformers.js in the browser Cache API on
// first download; voice embeddings are captured by our HF fetch cache.
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import { extUrl } from '../lib/ext-url';
import { installHfFetchCache } from '../lib/hf-cache';
import { KOKORO_HF_MODEL, KOKORO_VOICE_IDS, kokoroVoiceUrl } from './model-storage';
import type { ProgressFn, TTSEngine } from './types';

const HF_MODEL = KOKORO_HF_MODEL;
const DTYPE = 'q8';

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
  // works offline forever after. installHfFetchCache() awaits each cache write,
  // so every voice is on disk by the time this returns.
  for (const voice of KOKORO_VOICE_IDS) {
    await fetch(kokoroVoiceUrl(voice));
  }
  report();
}

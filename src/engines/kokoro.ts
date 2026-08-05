// Kokoro-82M via kokoro-js / transformers.js (WASM, 8-bit quantized).
// Model weights are cached by transformers.js in the browser Cache API on
// first download; voice embeddings are captured by our HF fetch cache.
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import { extUrl } from '../lib/ext-url';
import { installHfFetchCache } from '../lib/hf-cache';
import { KOKORO_HF_MODEL, KOKORO_VOICE_IDS, kokoroVoiceUrl } from './model-storage';
import { wasmThreads } from './accel';
import type { EngineOptions, ProgressFn, TTSEngine } from './types';

const HF_MODEL = KOKORO_HF_MODEL;
const DTYPE = 'q8';

function configureTransformers(accel = false): void {
  installHfFetchCache();
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  // Serve the ONNX runtime WASM from inside the extension (never a CDN).
  // Threads only engage under the acceleration beta AND cross-origin
  // isolation (COEP/COOP manifest keys, Chrome); transformers.js clamps the
  // count back to 1 everywhere else. WebGPU is deliberately not offered for
  // Kokoro: it would require non-q8 weights — a separate ~300 MB download —
  // for gains the 8-bit WASM path doesn't need.
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    wasm.wasmPaths = extUrl('wasm/tjs/');
    wasm.numThreads = wasmThreads(accel);
  }
}

interface TransformersProgress {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

async function loadModel(
  onProgress?: (p: TransformersProgress) => void,
  accel = false,
): Promise<KokoroTTS> {
  configureTransformers(accel);
  return KokoroTTS.from_pretrained(HF_MODEL, {
    dtype: DTYPE,
    device: 'wasm',
    progress_callback: onProgress as never,
  });
}

export async function createEngine(
  onProgress?: (detail: string) => void,
  opts?: EngineOptions,
): Promise<TTSEngine> {
  const threads = wasmThreads(opts?.accel ?? false);
  const suffix = threads > 1 ? ` (${threads} threads)` : '';
  const tts = await loadModel((p) => {
    if (p.status === 'progress' && p.total) {
      onProgress?.(
        `Loading Kokoro-82M… ${Math.round(((p.loaded ?? 0) / p.total) * 100)}%${suffix}`,
      );
    }
  }, opts?.accel ?? false);
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

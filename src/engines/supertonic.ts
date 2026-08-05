// Supertonic TTS (Supertone) via onnxruntime-web, ported from the official
// browser demo (supertone-inc/supertonic web/helper.js, MIT). Pipeline:
// unicode tokenizer → duration predictor → text encoder → flow-matching
// vector estimator (8 denoise steps) → vocoder → 44.1 kHz waveform.
// Model weights are OpenRAIL-M licensed (see the HF repo LICENSE).
// Same onnxruntime-web build as piper-tts-web imports, so both engines share
// one bundled copy of the (jsep) WASM runtime under wasm/ort/.
import * as ort from 'onnxruntime-web';
import { extUrl } from '../lib/ext-url';
import { cachedBuffer, fetchToCache } from './downloader';
import {
  SUPERTONIC_BASE as BASE,
  SUPERTONIC_FILES,
  SUPERTONIC_ONNX as ONNX_MODELS,
} from './model-storage';
import { preprocessText, textToIds } from './supertonic-text';
import { wasmThreads, webgpuAvailable } from './accel';
import type { EngineOptions, ProgressFn, SynthesisResult, TTSEngine } from './types';

const DENOISE_STEPS = 8;

interface Cfgs {
  ae: { sample_rate: number; base_chunk_size: number };
  ttl: { chunk_compress_factor: number; latent_dim: number };
}
interface StyleJson {
  style_ttl: { dims: number[]; data: number[] };
  style_dp: { dims: number[]; data: number[] };
}

let ortConfigured = false;
function configureOrt(accel = false): void {
  if (ortConfigured) return;
  ortConfigured = true;
  ort.env.wasm.wasmPaths = extUrl('wasm/ort/');
  // >1 only under the acceleration beta with cross-origin isolation; the
  // count is fixed at first session creation, which is why this engine is
  // cached per (model, accel) and reloaded when the toggle flips.
  ort.env.wasm.numThreads = wasmThreads(accel);
  ort.env.wasm.proxy = false;
}

async function cachedJson<T>(url: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await cachedBuffer(url))) as T;
}

function gaussianNoise(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(0.0001, Math.random());
    const u2 = Math.random();
    out[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  return out;
}

export async function createEngine(
  onProgress?: (detail: string) => void,
  opts?: EngineOptions,
): Promise<TTSEngine> {
  const accel = opts?.accel ?? false;
  configureOrt(accel);
  const [cfgs, indexer] = await Promise.all([
    cachedJson<Cfgs>(`${BASE}onnx/tts.json`),
    cachedJson<number[]>(`${BASE}onnx/unicode_indexer.json`),
  ]);

  // WebGPU is attempted per session with a WASM retry: an adapter can exist
  // and still fail at session creation (unsupported ops, driver limits), and
  // one stubborn model must not take down the other three.
  const useGpu = accel && (await webgpuAvailable());
  const threads = wasmThreads(accel);
  const mode = useGpu ? ' (GPU)' : threads > 1 ? ` (${threads} threads)` : '';
  const createSession = async (buf: ArrayBuffer): Promise<ort.InferenceSession> => {
    if (useGpu) {
      try {
        return await ort.InferenceSession.create(new Uint8Array(buf), {
          executionProviders: ['webgpu', 'wasm'],
        });
      } catch {
        // Fall through to the plain WASM path.
      }
    }
    return ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ['wasm'] });
  };

  const sessions: ort.InferenceSession[] = [];
  for (const [i, file] of ONNX_MODELS.entries()) {
    onProgress?.(`Loading Supertonic… (${i + 1}/${ONNX_MODELS.length})${mode}`);
    const buf = await cachedBuffer(file.url);
    sessions.push(await createSession(buf));
  }
  const [durationPredictor, textEncoder, vectorEstimator, vocoder] = sessions;

  const styles = new Map<string, { ttl: ort.Tensor; dp: ort.Tensor }>();
  async function getStyle(voice: string) {
    let style = styles.get(voice);
    if (!style) {
      const json = await cachedJson<StyleJson>(`${BASE}voice_styles/${voice}.json`);
      const toTensor = (t: StyleJson['style_ttl']) =>
        new ort.Tensor('float32', new Float32Array(t.data.flat(Infinity as 1)), [
          1,
          t.dims[1],
          t.dims[2],
        ]);
      style = { ttl: toTensor(json.style_ttl), dp: toTensor(json.style_dp) };
      styles.set(voice, style);
    }
    return style;
  }

  async function synthesize(text: string, voice = 'F1'): Promise<SynthesisResult> {
    const style = await getStyle(voice);
    const ids = textToIds(preprocessText(text), indexer);
    const len = ids.length;
    const textIds = new ort.Tensor('int64', ids, [1, len]);
    const textMask = new ort.Tensor('float32', new Float32Array(len).fill(1), [1, 1, len]);

    const dpOut = await durationPredictor.run({
      text_ids: textIds,
      style_dp: style.dp,
      text_mask: textMask,
    });
    const durationSec = Number((dpOut['duration'].data as Float32Array)[0]);

    const encOut = await textEncoder.run({
      text_ids: textIds,
      style_ttl: style.ttl,
      text_mask: textMask,
    });
    const textEmb = encOut['text_emb'];

    const chunkSize = cfgs.ae.base_chunk_size * cfgs.ttl.chunk_compress_factor;
    const wavLen = Math.floor(durationSec * cfgs.ae.sample_rate);
    const latentLen = Math.floor((wavLen + chunkSize - 1) / chunkSize);
    const latentDim = cfgs.ttl.latent_dim * cfgs.ttl.chunk_compress_factor;

    let xt = gaussianNoise(latentDim * latentLen);
    const latentMask = new ort.Tensor('float32', new Float32Array(latentLen).fill(1), [
      1,
      1,
      latentLen,
    ]);
    const totalStep = new ort.Tensor('float32', new Float32Array([DENOISE_STEPS]), [1]);

    for (let step = 0; step < DENOISE_STEPS; step++) {
      const out = await vectorEstimator.run({
        noisy_latent: new ort.Tensor('float32', xt, [1, latentDim, latentLen]),
        text_emb: textEmb,
        style_ttl: style.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new ort.Tensor('float32', new Float32Array([step]), [1]),
        total_step: totalStep,
      });
      xt = out['denoised_latent'].data as Float32Array;
    }

    const vocOut = await vocoder.run({
      latent: new ort.Tensor('float32', xt, [1, latentDim, latentLen]),
    });
    const samples = vocOut['wav_tts'].data as Float32Array;
    return { samples: Float32Array.from(samples), sampleRate: cfgs.ae.sample_rate };
  }

  return {
    synthesize,
    dispose() {
      for (const s of sessions) void s.release().catch(() => {});
    },
  };
}

export async function download(onProgress: ProgressFn): Promise<void> {
  await fetchToCache(SUPERTONIC_FILES, onProgress);
}

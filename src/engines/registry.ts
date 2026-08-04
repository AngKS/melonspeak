// Model catalog: real names and download sizes shown to the user, plus lazy
// loaders so heavy engine code is only fetched when actually used.
import type { ModelId } from '../lib/messages';
import type { EngineModule } from './types';

export interface ModelMeta {
  id: ModelId;
  /** Friendly name in pickers */
  shortName: string;
  /** Real model name + variant, always shown during onboarding */
  displayName: string;
  /** Approximate total download size in bytes */
  sizeBytes: number;
  description: string;
  /** Per-chunk character cap. Kokoro silently truncates (and can corrupt)
   *  past ~509 phoneme tokens; community sweet spot is 80–150 chars
   *  (hexgrad/kokoro#200). Supertonic trains on ≤~350-char segments and its
   *  own examples cap at 300 (supertonic#31). */
  maxChunkChars: number;
  recommended?: boolean;
  voices?: { id: string; label: string }[];
  defaultVoice?: string;
}

export const MODELS: Record<ModelId, ModelMeta> = {
  kokoro: {
    id: 'kokoro',
    shortName: 'Kokoro',
    displayName: 'Kokoro-82M v1.0 (ONNX, 8-bit)',
    sizeBytes: 97_000_000,
    description:
      'The most natural-sounding voice for its size. 9 English voices (US & UK), great for long articles.',
    maxChunkChars: 150,
    recommended: true,
    voices: [
      { id: 'af_heart', label: 'Heart · US female' },
      { id: 'af_bella', label: 'Bella · US female' },
      { id: 'af_nicole', label: 'Nicole · US female (soft)' },
      { id: 'am_michael', label: 'Michael · US male' },
      { id: 'am_fenrir', label: 'Fenrir · US male' },
      { id: 'am_puck', label: 'Puck · US male' },
      { id: 'bf_emma', label: 'Emma · UK female' },
      { id: 'bm_george', label: 'George · UK male' },
      { id: 'bm_fable', label: 'Fable · UK narrator' },
    ],
    defaultVoice: 'af_heart',
  },
  supertonic: {
    id: 'supertonic',
    shortName: 'Supertonic',
    displayName: 'Supertonic TTS (ONNX, 44.1 kHz)',
    sizeBytes: 264_000_000,
    description:
      'Fast flow-matching TTS by Supertone with the highest audio fidelity (44.1 kHz). Two voices.',
    maxChunkChars: 300,
    voices: [
      { id: 'F1', label: 'F1 · female' },
      { id: 'M1', label: 'M1 · male' },
    ],
    defaultVoice: 'F1',
  },
  piper: {
    id: 'piper',
    shortName: 'Piper',
    displayName: 'Piper en_US-hfc_female (medium, ONNX)',
    sizeBytes: 63_300_000,
    description:
      'Smallest download. A proven, dependable voice — a fine pick if disk space is tight.',
    maxChunkChars: 300,
  },
};

export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

export function loadEngineModule(id: ModelId): Promise<EngineModule> {
  switch (id) {
    case 'kokoro':
      return import('./kokoro');
    case 'supertonic':
      return import('./supertonic');
    case 'piper':
      return import('./piper');
  }
}

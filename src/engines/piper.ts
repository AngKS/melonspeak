// Piper TTS (en_US-hfc_female-medium) via @mintplex-labs/piper-tts-web.
// The model is cached in OPFS by the library; the espeak-ng phonemizer WASM
// and ONNX runtime are bundled inside the extension, so after the one-time
// model download everything runs offline.
import * as piper from '@mintplex-labs/piper-tts-web';
import { extUrl } from '../lib/ext-url';
import { decodeWav } from '../lib/wav';
import type { ProgressFn, TTSEngine } from './types';

const VOICE_ID = 'en_US-hfc_female-medium';
const MODEL_BYTES = 63_201_294;

const WASM_PATHS = {
  onnxWasm: extUrl('wasm/ort/'),
  piperWasm: extUrl('wasm/piper/piper_phonemize.wasm'),
  piperData: extUrl('wasm/piper/piper_phonemize.data'),
};

export async function createEngine(onProgress?: (detail: string) => void): Promise<TTSEngine> {
  onProgress?.('Loading Piper…');
  const session = await piper.TtsSession.create({
    voiceId: VOICE_ID,
    wasmPaths: WASM_PATHS,
    progress: (p) => {
      if (p.total) onProgress?.(`Loading Piper… ${Math.round((p.loaded / p.total) * 100)}%`);
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
  await piper.download(VOICE_ID, (p) => {
    onProgress(p.loaded, p.total || MODEL_BYTES, VOICE_ID);
  });
}

export async function isDownloaded(): Promise<boolean> {
  return (await piper.stored()).includes(VOICE_ID);
}

export async function remove(): Promise<void> {
  await piper.remove(VOICE_ID);
}

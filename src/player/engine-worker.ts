// Dedicated worker hosting the TTS engines. All extension pages of one
// browser profile share a single renderer main thread, so running WASM
// inference on it froze every surface (popup, reader — and with them the
// browser UI) while a chunk synthesized. The player spawns one worker per
// loaded model; terminate() is the disposal path and reliably frees the
// model's WASM memory.
import { loadEngineModule } from '../engines/registry';
import type { TTSEngine } from '../engines/types';
import type { ModelId } from '../lib/messages';

export type WorkerRequest =
  | { type: 'load'; modelId: ModelId }
  | { type: 'synthesize'; id: number; text: string; voice?: string }
  | { type: 'download'; modelId: ModelId };

export type WorkerResponse =
  | { type: 'loaded' }
  | { type: 'load-progress'; detail: string }
  | { type: 'result'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'download-progress'; loaded: number; total: number; file?: string }
  | { type: 'downloaded' }
  | { type: 'error'; id?: number; message: string };

const scope = self as unknown as {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

let engine: TTSEngine | null = null;

scope.onmessage = (e) => void handle(e.data);

async function handle(req: WorkerRequest): Promise<void> {
  try {
    switch (req.type) {
      case 'load': {
        const mod = await loadEngineModule(req.modelId);
        engine = await mod.createEngine((detail) => scope.postMessage({ type: 'load-progress', detail }));
        scope.postMessage({ type: 'loaded' });
        break;
      }
      case 'synthesize': {
        if (!engine) throw new Error('No engine loaded');
        const result = await engine.synthesize(req.text, req.voice);
        // Copy before transfer: the result may be a view into WASM heap memory.
        const samples = new Float32Array(result.samples);
        scope.postMessage(
          { type: 'result', id: req.id, samples, sampleRate: result.sampleRate },
          [samples.buffer],
        );
        break;
      }
      case 'download': {
        const mod = await loadEngineModule(req.modelId);
        await mod.download((loaded, total, file) =>
          scope.postMessage({ type: 'download-progress', loaded, total, file }),
        );
        scope.postMessage({ type: 'downloaded' });
        break;
      }
    }
  } catch (err) {
    scope.postMessage({
      type: 'error',
      id: req.type === 'synthesize' ? req.id : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

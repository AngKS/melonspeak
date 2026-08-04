export interface SynthesisResult {
  samples: Float32Array;
  sampleRate: number;
}

export interface TTSEngine {
  synthesize(text: string, voice?: string): Promise<SynthesisResult>;
  /** Release model memory. The engine cannot be used afterwards. */
  dispose(): void;
}

export type ProgressFn = (loaded: number, total: number, file?: string) => void;

export interface EngineOptions {
  /** Beta hardware acceleration: engines may use multithreaded WASM and/or
   *  WebGPU when the platform supports it. Advisory — every engine must
   *  feature-detect and silently fall back to the plain WASM path. */
  accel?: boolean;
}

/** Shape of each engine module (kokoro.ts / supertonic.ts / piper.ts).
 *  Checking and deleting what's on disk lives in engines/model-storage.ts, so
 *  UI pages can do it without loading any engine code. */
export interface EngineModule {
  /** Instantiate and load model weights from local storage into memory. */
  createEngine(onProgress?: (detail: string) => void, opts?: EngineOptions): Promise<TTSEngine>;
  /** Download model files to local storage. Idempotent; skips cached files. */
  download(onProgress: ProgressFn): Promise<void>;
}

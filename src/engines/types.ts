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

/** Shape of each engine module (kokoro.ts / supertonic.ts / piper.ts). */
export interface EngineModule {
  /** Instantiate and load model weights from local storage into memory. */
  createEngine(onProgress?: (detail: string) => void): Promise<TTSEngine>;
  /** Download model files to local storage. Idempotent; skips cached files. */
  download(onProgress: ProgressFn): Promise<void>;
  isDownloaded(): Promise<boolean>;
  /** Delete downloaded files from local storage. */
  remove(): Promise<void>;
}

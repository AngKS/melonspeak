// The player context: runs TTS inference and plays audio. Hosted in the
// offscreen document on Chrome and in the background page on Firefox, so
// playback survives the popup closing.
import { chunkText } from '../lib/chunker';
import { expandForSpeech } from '../lib/tts-normalize';
import { broadcast } from '../lib/messages';
import { VIZ_PORT } from '../lib/messages';
import type {
  DownloadProgress,
  Message,
  ModelId,
  PlayerCommand,
  PlayerStatus,
  VizMessage,
} from '../lib/messages';
import { encodeWav, silentWav } from '../lib/wav';
import { MODELS } from '../engines/registry';
import type { SynthesisResult, TTSEngine } from '../engines/types';
import type { WorkerRequest, WorkerResponse } from './engine-worker';

/** How many chunks synthesis may run ahead of playback. */
const LOOKAHEAD = 2;
/** Free model memory (and close the offscreen doc) after this long idle. */
const IDLE_UNLOAD_MS = 5 * 60 * 1000;

let engine: TTSEngine | null = null;
let engineId: ModelId | null = null;
let session = 0;
let status: PlayerStatus = { state: 'idle', modelId: null };
let releaseAll: (() => void) | null = null;
let downloading = false;
const lastDownloadProgress = new Map<ModelId, DownloadProgress>();

let transcript: { chunks: string[]; title?: string } | null = null;

const audio = new Audio();
if ('preservesPitch' in audio) audio.preservesPitch = true;
// No chrome.storage in offscreen documents: speed arrives via commands.
let speed = 1;
/** Voice for chunks not yet synthesized; set-voice retargets it mid-read. */
let activeVoice: string | undefined;

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (msg && msg.target === 'player') {
    void handleCommand(msg.cmd);
    sendResponse(true); // ACK so the background knows this module is live
  }
});
// Same-page delivery on Firefox, where the background script is a sibling.
(globalThis as { __melonSpeakPlayerDeliver?: (c: PlayerCommand) => void }).__melonSpeakPlayerDeliver =
  (cmd) => void handleCommand(cmd);

async function handleCommand(cmd: PlayerCommand): Promise<void> {
  switch (cmd.type) {
    case 'speak':
      if (cmd.speed) speed = cmd.speed;
      await speak(cmd.text, cmd.title, cmd.modelId, cmd.voice);
      break;
    case 'set-speed':
      speed = cmd.speed;
      audio.playbackRate = speed;
      break;
    case 'set-voice':
      // Applies to chunks not yet synthesized; a stopped read is not the
      // right price for a voice change.
      if (cmd.modelId === engineId) activeVoice = cmd.voice;
      break;
    case 'pause':
      if (status.state === 'speaking') {
        audio.pause();
        setStatus({ ...status, state: 'paused' });
      }
      break;
    case 'resume':
      if (status.state === 'paused') {
        void audio.play().catch(() => {});
        setStatus({ ...status, state: 'speaking' });
      }
      break;
    case 'stop':
      stopAll();
      break;
    case 'model-changed':
      stopAll();
      disposeEngine();
      break;
    case 'get-status':
      broadcast({ target: 'ui', type: 'status', status });
      if (transcript) {
        broadcast({ target: 'ui', type: 'transcript', ...transcript });
      }
      for (const progress of lastDownloadProgress.values()) {
        broadcast({ target: 'ui', type: 'download-progress', progress });
      }
      break;
    case 'download':
      void download(cmd.modelIds);
      break;
  }
}

function setStatus(next: PlayerStatus): void {
  status = next;
  broadcast({ target: 'ui', type: 'status', status });
  updateKeepAlive();
  scheduleIdleUnload();
}

function errorStatus(detail: string, modelId: ModelId | null = null): void {
  setStatus({ state: 'error', modelId, detail });
}

function disposeEngine(): void {
  engine?.dispose();
  engine = null;
  engineId = null;
}

function stopAll(): void {
  session++;
  audio.pause();
  audio.removeAttribute('src');
  releaseAll?.();
  releaseAll = null;
  if (transcript) {
    // Don't let a stopped read linger as "FINISHED" in the reader.
    transcript = null;
    broadcast({ target: 'ui', type: 'transcript', chunks: [] });
  }
  if (status.state !== 'idle') setStatus({ state: 'idle', modelId: engineId });
}

async function speak(
  text: string,
  title?: string,
  modelId?: ModelId,
  voiceOverride?: string,
): Promise<void> {
  const my = ++session;
  audio.pause();
  audio.removeAttribute('src');
  releaseAll?.();

  if (!modelId) {
    errorStatus('No voice model installed yet — open MelonSpeak setup first.');
    return;
  }
  const meta = MODELS[modelId];

  try {
    if (!engine || engineId !== modelId) {
      disposeEngine();
      setStatus({ state: 'loading-model', modelId, detail: `Loading ${meta.displayName}…`, title });
      const eng = await createWorkerEngine(modelId, (detail) => {
        if (session === my) setStatus({ state: 'loading-model', modelId, detail, title });
      });
      if (session !== my) {
        eng.dispose();
        return;
      }
      engine = eng;
      engineId = modelId;
    }
  } catch (err) {
    if (session === my) {
      const message = errMsg(err);
      if (message.includes('missing from local storage')) {
        // Settings claimed the model was installed but its files are gone
        // (cache eviction / cleared site data). Reconcile instead of lying.
        broadcast({ target: 'ui', type: 'model-missing', modelId });
        errorStatus(
          `${meta.displayName} files are missing — re-download it from MelonSpeak setup.`,
          modelId,
        );
      } else {
        errorStatus(`Could not load ${meta.displayName}: ${message}`, modelId);
      }
    }
    return;
  }

  activeVoice = voiceOverride ?? meta.defaultVoice;
  const chunks = chunkText(text, meta.maxChunkChars);
  if (chunks.length === 0) {
    errorStatus('Nothing to read.', modelId);
    return;
  }
  transcript = { chunks, title };
  broadcast({ target: 'ui', type: 'transcript', chunks, title });

  // Producer/consumer: synthesis runs at most LOOKAHEAD chunks ahead of
  // playback; each played chunk is dropped to keep memory flat.
  const blobs: (Blob | undefined)[] = [];
  const skippedChunks = new Set<number>();
  let consecutiveFailures = 0;
  let playIndex = 0;
  let synthError: string | null = null;
  let notifyProduced: () => void = () => {};
  let notifyAdvanced: () => void = () => {};
  let playDone: (() => void) | null = null;
  releaseAll = () => {
    notifyProduced();
    notifyAdvanced();
    playDone?.();
  };

  void (async () => {
    for (let i = 0; i < chunks.length; i++) {
      while (session === my && i > playIndex + LOOKAHEAD) {
        await new Promise<void>((r) => (notifyAdvanced = r));
      }
      if (session !== my) return;
      try {
        const result = await engine!.synthesize(expandForSpeech(chunks[i]), activeVoice);
        if (session !== my) return;
        blobs[i] = encodeWav(result.samples, result.sampleRate);
        consecutiveFailures = 0;
      } catch (err) {
        if (session !== my) return;
        // One unpronounceable token must not end the whole read (OOV words
        // can crash engines outright); give up only on repeated failures.
        if (++consecutiveFailures >= 3) throw err;
        skippedChunks.add(i);
      }
      notifyProduced();
    }
  })().catch((err) => {
    synthError = errMsg(err);
    notifyProduced();
  });

  setStatus({ state: 'speaking', modelId, title, chunkIndex: 0, chunkCount: chunks.length });
  for (playIndex = 0; playIndex < chunks.length; playIndex++) {
    while (
      session === my &&
      !blobs[playIndex] &&
      !skippedChunks.has(playIndex) &&
      !synthError
    ) {
      await new Promise<void>((r) => (notifyProduced = r));
    }
    if (session !== my) return;
    if (synthError) {
      errorStatus(`Speech synthesis failed: ${synthError}`, modelId);
      return;
    }
    if (skippedChunks.has(playIndex)) {
      notifyAdvanced();
      continue;
    }
    setStatus({ state: 'speaking', modelId, title, chunkIndex: playIndex, chunkCount: chunks.length });
    const blob = blobs[playIndex]!;
    blobs[playIndex] = undefined;
    await new Promise<void>((resolve) => {
      const url = URL.createObjectURL(blob);
      const done = () => {
        URL.revokeObjectURL(url);
        audio.removeEventListener('ended', done);
        audio.removeEventListener('error', done);
        resolve();
      };
      // The abort path must run the same cleanup as natural completion, or
      // every interrupted chunk leaks its listeners and object URL.
      playDone = done;
      audio.addEventListener('ended', done);
      audio.addEventListener('error', done);
      audio.src = url;
      audio.playbackRate = speed;
      void audio.play().then(() => audioCtx?.resume().catch(() => {})).catch(() => done());
    });
    playDone = null;
    if (session !== my) return;
    notifyAdvanced();
  }
  releaseAll = null;
  setStatus({ state: 'idle', modelId });
}

// ---------------------------------------------------------------------------
// Keep-alive: Chrome closes AUDIO_PLAYBACK offscreen documents 30 seconds
// after audio stops, which would kill model loads, downloads, paused reads,
// and long synthesis gaps. A looping near-silent track holds the document
// open whenever the player is doing anything; it stops when truly idle.
// ---------------------------------------------------------------------------

const keepAlive = new Audio();
keepAlive.loop = true;
let keepAliveUrl: string | null = null;

function updateKeepAlive(): void {
  const busy =
    downloading ||
    status.state === 'loading-model' ||
    status.state === 'speaking' ||
    status.state === 'paused';
  if (busy && !keepAliveUrl) {
    keepAliveUrl = URL.createObjectURL(silentWav());
    keepAlive.src = keepAliveUrl;
    void keepAlive.play().catch(() => {});
  } else if (!busy && keepAliveUrl) {
    keepAlive.pause();
    keepAlive.removeAttribute('src');
    URL.revokeObjectURL(keepAliveUrl);
    keepAliveUrl = null;
  }
}

// ---------------------------------------------------------------------------
// Engine worker plumbing. Inference and downloads run in a dedicated worker:
// extension pages share one renderer main thread, and WASM synthesis on it
// froze the popup (and the browser UI with it) whenever reading was active.
// ---------------------------------------------------------------------------

function spawnEngineWorker(): Worker {
  return new Worker(chrome.runtime.getURL('player/engine-worker.js'), { type: 'module' });
}

function createWorkerEngine(
  modelId: ModelId,
  onProgress: (detail: string) => void,
): Promise<TTSEngine> {
  const worker = spawnEngineWorker();
  const pending = new Map<number, { resolve: (r: SynthesisResult) => void; reject: (e: Error) => void }>();
  let seq = 0;
  return new Promise((resolveLoad, rejectLoad) => {
    let loaded = false;
    const failAll = (err: Error) => {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      if (!loaded) {
        worker.terminate();
        rejectLoad(err);
      }
    };
    worker.onerror = (e) => failAll(new Error(e.message || 'Engine worker failed'));
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'load-progress':
          onProgress(msg.detail);
          break;
        case 'loaded':
          loaded = true;
          resolveLoad({
            synthesize(text, voice) {
              return new Promise((resolve, reject) => {
                pending.set(++seq, { resolve, reject });
                worker.postMessage({ type: 'synthesize', id: seq, text, voice } satisfies WorkerRequest);
              });
            },
            dispose() {
              // Terminating the worker reliably frees the model's WASM memory
              // and aborts any in-flight inference.
              worker.terminate();
            },
          });
          break;
        case 'result': {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          p?.resolve({ samples: msg.samples, sampleRate: msg.sampleRate });
          break;
        }
        case 'error': {
          if (msg.id !== undefined) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            p?.reject(new Error(msg.message));
          } else {
            failAll(new Error(msg.message));
          }
          break;
        }
      }
    };
    worker.postMessage({ type: 'load', modelId } satisfies WorkerRequest);
  });
}

function downloadInWorker(
  modelId: ModelId,
  onProgress: (loaded: number, total: number, file?: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = spawnEngineWorker();
    const fail = (message: string) => {
      worker.terminate();
      reject(new Error(message));
    };
    worker.onerror = (e) => fail(e.message || 'Download worker failed');
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'download-progress') {
        onProgress(msg.loaded, msg.total, msg.file);
      } else if (msg.type === 'downloaded') {
        worker.terminate();
        resolve();
      } else if (msg.type === 'error') {
        fail(msg.message);
      }
    };
    worker.postMessage({ type: 'download', modelId } satisfies WorkerRequest);
  });
}

// ---------------------------------------------------------------------------
// Model downloads. These run here (not in the onboarding tab) so closing the
// tab doesn't cancel them. Requests arriving while a download is running are
// queued, never dropped.
// ---------------------------------------------------------------------------

const downloadQueue: ModelId[] = [];
let activeDownload: ModelId | null = null;

async function download(ids: ModelId[]): Promise<void> {
  for (const id of ids) {
    if (id !== activeDownload && !downloadQueue.includes(id)) downloadQueue.push(id);
  }
  if (downloading) return;
  downloading = true;
  updateKeepAlive();
  try {
    while (downloadQueue.length > 0) {
      const id = downloadQueue.shift()!;
      activeDownload = id;
      const meta = MODELS[id];
      const report = (progress: DownloadProgress) => {
        lastDownloadProgress.set(id, progress);
        broadcast({ target: 'ui', type: 'download-progress', progress });
      };
      try {
        await downloadInWorker(id, (loaded, total, file) =>
          report({ modelId: id, loaded, total, file, done: false }),
        );
        // The background script persists the downloaded flag on this event.
        report({ modelId: id, loaded: meta.sizeBytes, total: meta.sizeBytes, done: true });
        // Settings are the durable record; replaying stale "done" events on
        // every get-status only re-triggers persistence handlers.
        lastDownloadProgress.delete(id);
      } catch (err) {
        report({ modelId: id, loaded: 0, total: meta.sizeBytes, done: true, error: errMsg(err) });
      }
    }
  } finally {
    activeDownload = null;
    downloading = false;
    updateKeepAlive();
    scheduleIdleUnload();
  }
}

// ---------------------------------------------------------------------------
// Visualizer stream for the Now Reading view. Audio is routed through an
// AnalyserNode; compact spectrum levels are pushed over a Port at ~15 fps,
// only while a view is connected and something is speaking.
// ---------------------------------------------------------------------------

const VIZ_BARS = 24;
const VIZ_INTERVAL_MS = 66;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
const vizPorts = new Set<chrome.runtime.Port>();
let vizTimer: ReturnType<typeof setInterval> | undefined;

function ensureAnalyser(): void {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaElementSource(audio);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.7;
  source.connect(analyser);
  analyser.connect(audioCtx.destination);
  void audioCtx.resume().catch(() => {});
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== VIZ_PORT) return;
  ensureAnalyser();
  vizPorts.add(port);
  port.onDisconnect.addListener(() => {
    vizPorts.delete(port);
    if (vizPorts.size === 0 && vizTimer !== undefined) {
      clearInterval(vizTimer);
      vizTimer = undefined;
    }
  });
  const snapshot: VizMessage = {
    type: 'snapshot',
    status,
    chunks: transcript?.chunks ?? null,
    title: transcript?.title,
  };
  port.postMessage(snapshot);
  if (vizTimer === undefined) {
    vizTimer = setInterval(pushLevels, VIZ_INTERVAL_MS);
  }
});

function pushLevels(): void {
  if (vizPorts.size === 0 || status.state !== 'speaking' || !analyser) return;
  const bins = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(bins);
  const levels: number[] = new Array(VIZ_BARS);
  const per = bins.length / VIZ_BARS;
  for (let b = 0; b < VIZ_BARS; b++) {
    let sum = 0;
    const start = Math.floor(b * per);
    const end = Math.floor((b + 1) * per);
    for (let i = start; i < end; i++) sum += bins[i];
    levels[b] = Math.min(1, sum / Math.max(1, end - start) / 255);
  }
  const msg: VizMessage = { type: 'levels', levels };
  for (const p of vizPorts) p.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Idle teardown: free model memory, and on Chrome close the offscreen
// document entirely so the extension costs nothing while unused.
// ---------------------------------------------------------------------------

let idleTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleIdleUnload(): void {
  clearTimeout(idleTimer);
  if (status.state !== 'idle' && status.state !== 'error') return;
  idleTimer = setTimeout(() => {
    if ((status.state !== 'idle' && status.state !== 'error') || downloading) return;
    disposeEngine();
    if (location.pathname.endsWith('offscreen.html')) window.close();
  }, IDLE_UNLOAD_MS);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

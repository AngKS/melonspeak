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
import { binLevels } from '../lib/viz-levels';
import { MODELS } from '../engines/registry';
import type { SynthesisResult, TTSEngine } from '../engines/types';
import type { WorkerRequest, WorkerResponse } from './engine-worker';

/** Keep this many seconds of audio synthesized ahead of the play position
 *  (scaled by playback speed). A duration target — not a chunk count — because
 *  chunks span ~2–20 s of audio: it lets spare synthesis capacity accumulate
 *  real headroom that absorbs slow chunks instead of stalling mid-read.
 *  60 s of 16-bit WAV is 3–5 MB depending on the engine's sample rate. */
const BUFFER_AHEAD_SEC = 60;
/** Cap for the opening chunk(s): the first spoken word waits on the first
 *  synthesis, so the read opens with short chunks and ramps up. */
const FIRST_CHUNK_CHARS = 80;
/** Free model memory (and close the offscreen doc) after this long idle. */
const IDLE_UNLOAD_MS = 5 * 60 * 1000;

let engine: TTSEngine | null = null;
let engineId: ModelId | null = null;
/** In-flight engine load, shared so a 'prepare' fired during page extraction
 *  and the 'speak' that follows it await one load instead of racing two
 *  workers for the same model. */
let engineLoad: {
  modelId: ModelId;
  promise: Promise<TTSEngine>;
  onProgress: (detail: string) => void;
} | null = null;
let session = 0;
let status: PlayerStatus = { state: 'idle', modelId: null };
let releaseAll: (() => void) | null = null;
/** Installed by an active speak(); jumps playback to a chunk index. */
let seekTo: ((index: number) => void) | null = null;
/** Installed by an active speak(); re-wakes the producer when the buffer
 *  target changes (a speed change grows/shrinks it). */
let wakeSynthesis: (() => void) | null = null;
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
      // Faster playback needs a bigger synthesized-ahead buffer; let the
      // producer re-evaluate its target.
      wakeSynthesis?.();
      break;
    case 'prepare':
      if (cmd.modelId) await prepare(cmd.modelId);
      break;
    case 'set-voice':
      // Applies to chunks not yet synthesized; a stopped read is not the
      // right price for a voice change.
      if (cmd.modelId === engineId) activeVoice = cmd.voice;
      break;
    case 'seek':
      seekTo?.(cmd.index);
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
      abandonEngineLoad();
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

/** Drops an in-flight load whose model is no longer wanted; its engine is
 *  disposed on arrival so the worker never outlives its usefulness. */
function abandonEngineLoad(): void {
  if (!engineLoad) return;
  const stale = engineLoad;
  engineLoad = null;
  stale.onProgress = () => {};
  stale.promise.then(
    (eng) => eng.dispose(),
    () => {},
  );
}

/** Returns the ready engine for `modelId`, starting or joining a load as
 *  needed. The latest caller owns the progress line. On success the engine is
 *  installed as the module engine (unless a different-model load superseded
 *  this one meanwhile — callers detect that via their session check). */
async function ensureEngine(
  modelId: ModelId,
  onProgress: (detail: string) => void,
): Promise<TTSEngine> {
  if (engine && engineId === modelId) return engine;
  if (engineLoad?.modelId !== modelId) {
    abandonEngineLoad();
    // Free the old model before loading the new one to keep peak memory low.
    disposeEngine();
    const fresh = { modelId, onProgress } as NonNullable<typeof engineLoad>;
    fresh.promise = createWorkerEngine(modelId, (detail) => fresh.onProgress(detail));
    engineLoad = fresh;
  }
  const load = engineLoad;
  load.onProgress = onProgress;
  try {
    const eng = await load.promise;
    if (engineLoad === load) {
      engineLoad = null;
      engine = eng;
      engineId = modelId;
    }
    return eng;
  } catch (err) {
    if (engineLoad === load) engineLoad = null;
    throw err;
  }
}

/** Warm-up for a read that is still being extracted: loads the model so the
 *  following 'speak' finds it ready. Never touches an active read. */
async function prepare(modelId: ModelId): Promise<void> {
  if (status.state !== 'idle' && status.state !== 'error') return;
  if (engine && engineId === modelId) return;
  // Any command that could interfere (speak, stop, model-changed) bumps the
  // session, so `session === my` means this prepare still owns the status.
  const my = session;
  const meta = MODELS[modelId];
  setStatus({ state: 'loading-model', modelId, detail: `Loading ${meta.displayName}…` });
  try {
    await ensureEngine(modelId, (detail) => {
      if (session === my) setStatus({ state: 'loading-model', modelId, detail });
    });
  } catch {
    // A failed warm-up stays quiet: speak() re-attempts the load and surfaces
    // the error with full context (model-missing reconciliation included).
  }
  if (session === my) setStatus({ state: 'idle', modelId: engineId });
}

function stopAll(): void {
  session++;
  audio.pause();
  audio.removeAttribute('src');
  releaseAll?.();
  releaseAll = null;
  seekTo = null;
  wakeSynthesis = null;
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
  setStatus({ state: 'preparing', modelId, title, detail: 'Preparing audio…' });

  // Chunk and publish the transcript before the model load: the reader can
  // show the text right away instead of after seconds of engine loading.
  activeVoice = voiceOverride ?? meta.defaultVoice;
  const chunks = chunkText(text, meta.maxChunkChars, FIRST_CHUNK_CHARS);
  if (chunks.length === 0) {
    errorStatus('Nothing to read.', modelId);
    return;
  }
  transcript = { chunks, title };
  broadcast({ target: 'ui', type: 'transcript', chunks, title });

  let eng: TTSEngine;
  try {
    if (!engine || engineId !== modelId) {
      setStatus({ state: 'loading-model', modelId, detail: `Loading ${meta.displayName}…`, title });
    }
    eng = await ensureEngine(modelId, (detail) => {
      if (session === my) setStatus({ state: 'loading-model', modelId, detail, title });
    });
    if (session !== my) return;
  } catch (err) {
    if (session === my) {
      // The transcript was already published; a read that never starts must
      // not leave it lingering in the reader.
      transcript = null;
      broadcast({ target: 'ui', type: 'transcript', chunks: [] });
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

  // Producer/consumer: synthesis runs ahead of playback in the background
  // until BUFFER_AHEAD_SEC (speed-scaled) of audio is buffered from the play
  // position, so one slow chunk drains headroom instead of stalling the read.
  // Played chunks are dropped to keep memory bounded, and a seek un-marks
  // freed chunks so they re-synthesize.
  const blobs: (Blob | undefined)[] = [];
  /** Seconds of audio per synthesized chunk; drives the buffer target. */
  const durations: number[] = new Array<number>(chunks.length).fill(0);
  const synthesized: boolean[] = new Array<boolean>(chunks.length).fill(false);
  const skippedChunks = new Set<number>();
  let consecutiveFailures = 0;
  let playIndex = 0;
  let pendingSeek: number | null = null;
  let synthError: string | null = null;
  let notifyProduced: () => void = () => {};
  let notifyAdvanced: () => void = () => {};
  let playDone: (() => void) | null = null;
  releaseAll = () => {
    notifyProduced();
    notifyAdvanced();
    playDone?.();
  };
  wakeSynthesis = () => notifyAdvanced();
  seekTo = (index: number) => {
    pendingSeek = Math.max(0, Math.min(chunks.length - 1, Math.floor(index)));
    // Buffered audio behind the target is dead weight — a forward jump would
    // otherwise strand up to a full buffer of never-played blobs.
    for (let j = 0; j < pendingSeek; j++) blobs[j] = undefined;
    // Freed (already-played) chunks must synthesize again; a previously
    // failed chunk gets another chance on explicit user intent.
    for (let j = 0; j < synthesized.length; j++) if (!blobs[j]) synthesized[j] = false;
    skippedChunks.delete(pendingSeek);
    audio.pause();
    notifyProduced();
    notifyAdvanced();
    playDone?.();
  };

  void (async () => {
    for (;;) {
      if (session !== my) return;
      // Walk the contiguous buffered run from the play position; synthesize
      // the first missing chunk unless the run already meets the target.
      let next = -1;
      let ahead = 0;
      const target = BUFFER_AHEAD_SEC * speed;
      for (let j = playIndex; j < chunks.length && ahead < target; j++) {
        if (skippedChunks.has(j)) continue;
        if (blobs[j]) {
          ahead += durations[j];
          continue;
        }
        if (!synthesized[j]) next = j;
        break;
      }
      if (next === -1) {
        if (playIndex >= chunks.length) return; // playback finished
        // Buffer satisfied; wait for playback to advance, a seek, or a
        // speed change to move the target.
        await new Promise<void>((r) => (notifyAdvanced = r));
        continue;
      }
      try {
        const result = await eng.synthesize(expandForSpeech(chunks[next]), activeVoice);
        if (session !== my) return;
        blobs[next] = encodeWav(result.samples, result.sampleRate);
        durations[next] = result.samples.length / result.sampleRate;
        synthesized[next] = true;
        consecutiveFailures = 0;
      } catch (err) {
        if (session !== my) return;
        // One unpronounceable token must not end the whole read (OOV words
        // can crash engines outright); give up only on repeated failures.
        if (++consecutiveFailures >= 3) throw err;
        skippedChunks.add(next);
      }
      notifyProduced();
    }
  })().catch((err) => {
    synthError = errMsg(err);
    notifyProduced();
  });

  // Stay in 'preparing' until the first chunk is actually ready to play —
  // the reader animates the visualizer during this window.
  setStatus({ state: 'preparing', modelId, title, detail: 'Preparing audio…' });
  while (playIndex < chunks.length) {
    if (pendingSeek !== null) {
      playIndex = pendingSeek;
      pendingSeek = null;
      notifyAdvanced(); // retarget the producer's window
    }
    while (
      session === my &&
      !blobs[playIndex] &&
      !skippedChunks.has(playIndex) &&
      !synthError &&
      pendingSeek === null
    ) {
      await new Promise<void>((r) => (notifyProduced = r));
    }
    if (session !== my) return;
    if (pendingSeek !== null) continue;
    if (synthError) {
      errorStatus(`Speech synthesis failed: ${synthError}`, modelId);
      return;
    }
    if (skippedChunks.has(playIndex)) {
      playIndex++;
      notifyAdvanced();
      continue;
    }
    setStatus({ state: 'speaking', modelId, title, chunkIndex: playIndex, chunkCount: chunks.length });
    const blob = blobs[playIndex]!;
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
    if (pendingSeek !== null) continue;
    // Freed only after playing (not before): a seek back to the current line
    // then replays from the buffer instead of re-synthesizing.
    blobs[playIndex] = undefined;
    playIndex++;
    notifyAdvanced();
  }
  releaseAll = null;
  seekTo = null;
  wakeSynthesis = null;
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
    status.state === 'preparing' ||
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
              // and aborts any in-flight inference. Terminated workers never
              // answer, so settle the waiters or they (and everything their
              // closures hold, like a session's audio buffer) leak.
              worker.terminate();
              const err = new Error('Engine disposed');
              for (const p of pending.values()) p.reject(err);
              pending.clear();
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
  // 2048-point FFT: the log-spaced bars need fine bins at the low end —
  // at fftSize 128 the bottom seven bars would all read the same bin.
  analyser.fftSize = 2048;
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
  if (vizPorts.size === 0 || status.state !== 'speaking' || !analyser || !audioCtx) return;
  const bins = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(bins);
  const levels = binLevels(bins, audioCtx.sampleRate, VIZ_BARS);
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

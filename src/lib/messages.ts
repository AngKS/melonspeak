export type ModelId = 'kokoro' | 'supertonic' | 'piper';

export type PlayerState =
  | 'idle'
  /** Between the user's request and the first audible audio: extraction,
   *  chunking, first-chunk synthesis. */
  | 'preparing'
  | 'loading-model'
  | 'speaking'
  | 'paused'
  | 'error';

export interface PlayerStatus {
  state: PlayerState;
  modelId: ModelId | null;
  /** Human-readable detail, e.g. an error message or "Loading Kokoro-82M…" */
  detail?: string;
  chunkIndex?: number;
  chunkCount?: number;
  /** Title of what is being read */
  title?: string;
}

export interface DownloadProgress {
  modelId: ModelId;
  /** Bytes downloaded across all files of this model */
  loaded: number;
  total: number;
  file?: string;
  done: boolean;
  error?: string;
}

// The player context (offscreen document on Chrome) has no chrome.storage
// access, so 'speak' arrives pre-enriched by the background script with the
// resolved model/voice/speed from settings.
export type PlayerCommand =
  | { type: 'speak'; text: string; title?: string; modelId?: ModelId; voice?: string; speed?: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'get-status' }
  | { type: 'model-changed' }
  | { type: 'set-voice'; modelId: ModelId; voice: string }
  | { type: 'set-speed'; speed: number }
  /** Jump playback to a chunk of the current transcript. */
  | { type: 'seek'; index: number }
  | { type: 'download'; modelIds: ModelId[] };

export type Message =
  | { target: 'player'; cmd: PlayerCommand }
  // tabId is set by the reading view, which knows the active tab of its own
  // window; without it the background falls back to lastFocusedWindow, which
  // is only unambiguous when the request came from a popup.
  | { target: 'background'; type: 'read-page'; tabId?: number }
  | { target: 'background'; type: 'read-selection'; tabId?: number }
  | { target: 'background'; type: 'player-cmd'; cmd: PlayerCommand }
  /** A UI page checked which models are really on disk (engines/model-storage).
   *  The background owns the downloaded flags, so it reconciles settings. */
  | {
      target: 'background';
      type: 'installed-state';
      installed: Partial<Record<ModelId, boolean>>;
    }
  /** Onboarding's sample belongs to no tab; it must drop a stale one. */
  | { target: 'background'; type: 'clear-reading-tab' }
  | { target: 'ui'; type: 'status'; status: PlayerStatus }
  | { target: 'ui'; type: 'download-progress'; progress: DownloadProgress }
  | { target: 'ui'; type: 'transcript'; chunks: string[]; title?: string }
  /** The player found a model's local files gone; settings must be reconciled. */
  | { target: 'ui'; type: 'model-missing'; modelId: ModelId };

/** Port name for the visualizer level stream (player → Now Reading view). */
export const VIZ_PORT = 'melonspeak-viz';

/** Messages sent over the visualizer port. */
export type VizMessage =
  | { type: 'snapshot'; status: PlayerStatus; chunks: string[] | null; title?: string }
  | { type: 'levels'; levels: number[] };

/** Port name for the highlight watcher (page → Now Reading view).
 *
 * A port rather than sendMessage: the watcher is injected into whatever tab
 * the user is looking at, and needs to know when to stop. Disconnection is
 * that signal — the view closing, leaving its idle state, or moving to another
 * tab all drop the port, and the watcher unhooks itself. A fire-and-forget
 * broadcaster would keep listening on every page for the life of the tab. */
export const SELECTION_PORT = 'melonspeak-selection';

/** Sent over the selection port on every (debounced) selection change. Only a
 *  clamped preview crosses the boundary — a book-length highlight stays in the
 *  page it came from. */
export interface SelectionMessage {
  /** Whitespace-collapsed, ellipsised preview of the highlighted text. */
  quote: string;
  words: number;
  /** Length of the *whole* selection, not the preview. */
  chars: number;
}

/** Fire-and-forget broadcast; swallows "no receiving end" errors.
 *
 * Also invokes the same-page sink if one is registered: runtime.sendMessage
 * is never delivered to the sender's own page, so on Firefox — where the
 * player and the background script share one background page — the
 * background's ui-message handling (settings persistence, error badge) would
 * otherwise never run. The background registers the sink; contexts without it
 * (Chrome offscreen document, UI pages) rely on sendMessage alone. */
export function broadcast(msg: Message): void {
  try {
    void chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    /* context shutting down */
  }
  (globalThis as { __melonBroadcastLocal?: (m: Message) => void }).__melonBroadcastLocal?.(msg);
}

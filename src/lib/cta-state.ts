// What the Now Reading view offers when it isn't reading. Pure, so the
// branching stays testable without a browser (same reasoning as reading-tab).
import type { PlayerState } from './messages';

/** Words per minute a voice model reads at, at 1× speed. Rough by nature:
 *  the spoken text is normalised (numbers expanded, URLs replaced) after this
 *  estimate is made. */
const WPM = 165;

/** Quote shown on the highlight card. Three clamped lines at panel widths. */
const QUOTE_CHARS = 240;

export type CtaView =
  /** Playback owns the panel. */
  | 'hidden'
  /** Nothing has been read: the cards are the panel's main content. */
  | 'full'
  /** A read ended: cards tuck under the transcript it left behind. */
  | 'compact';

export interface CtaInput {
  playerState: PlayerState;
  /** Whether the transcript still has lines on screen. */
  hasLines: boolean;
  /** Set when the background stopped the read because the tab closed. */
  stopReason: 'tab-closed' | null;
}

export function computeCtaView(input: CtaInput): CtaView {
  // The transcript is deliberately kept after a tab-close stop, even though
  // stopAll() broadcast an empty one — so this outranks hasLines.
  if (input.stopReason === 'tab-closed') return 'compact';
  switch (input.playerState) {
    case 'speaking':
    case 'paused':
    case 'loading-model':
      return 'hidden';
    // Something is already on its way. A card here would invite a second
    // request that cancels the first.
    case 'preparing':
      return 'hidden';
    case 'idle':
    case 'error':
      return input.hasLines ? 'compact' : 'full';
  }
}

export interface SelectionPreview {
  /** Single-line, ellipsised quote of the highlighted text. */
  quote: string;
  words: number;
  /** Length of the whole selection, not of the quote. */
  chars: number;
}

/** Runs in the page (the watcher), which is why it clamps: what it returns is
 *  what crosses into the extension. */
export function previewSelection(text: string): SelectionPreview {
  // Highlights routinely span block elements, so the raw text arrives full of
  // newlines and indentation the card must not render.
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return { quote: '', words: 0, chars: 0 };
  return {
    quote: flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS).trimEnd()}…` : flat,
    words: flat.split(' ').length,
    chars: flat.length,
  };
}

/** Runs in the view, which is the side that knows the user's saved speed.
 *  That speed is user-editable, so a zero or NaN must not reach the card as
 *  "~Infinity min". */
export function formatDuration(words: number, speed: number): string {
  if (words <= 0) return '';
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const seconds = Math.max(1, Math.round((words / (WPM * rate)) * 60));
  if (seconds < 60) return `~${seconds} s`;
  return `~${Math.max(1, Math.round(seconds / 60))} min`;
}

/** Hosts that block extension scripting even with <all_urls> granted. */
const BLOCKED_HOSTS = new Set([
  'chromewebstore.google.com',
  'chrome.google.com',
  'addons.mozilla.org',
]);

/** Whether the read-page card should offer to read this URL at all. Refusing
 *  up front beats letting the click land in a generic extraction error. */
export function isReadableUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return !BLOCKED_HOSTS.has(parsed.hostname);
  }
  return parsed.protocol === 'file:';
}

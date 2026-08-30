import type { PlayerState } from './messages';

/** storage.session key holding the tab being read. Written only by the
 *  background; the reading view observes it through storage.onChanged rather
 *  than a runtime message, because an MV3 worker can be torn down the moment
 *  a listener returns and drop anything queued after an await. */
export const READING_TAB_KEY = 'readingTab';

export interface ReadingTabState {
  tabId: number | null;
  /** Why it went away, when that changes what the reading view shows. */
  reason?: 'tab-closed';
  /** Address the transcript was extracted from, so a later navigation of the
   *  same tab can be recognised (and un-recognised, on a Back). */
  url?: string;
  /** That tab has since moved to another document; what is on screen belongs
   *  to a page that is no longer there. */
  navigated?: boolean;
  /** Where it moved to. Stored as well as `navigated` so that following a
   *  second link changes this record at all — the reading view has no other
   *  way to tell one navigation from the next. */
  movedTo?: string;
}

/** What the Now Reading header shows about the tab being read. */
export type BadgeState = 'none' | 'background' | 'navigated' | 'stopped-tab-closed';

export interface BadgeInput {
  /** Tab the current read came from; null when unknown or none. */
  readingTabId: number | null;
  /** Active tab of the window hosting the reading view; null when unknown. */
  activeTabId: number | null;
  playerState: PlayerState;
  /** Set when the background stopped the read because that tab closed. */
  stopReason: 'tab-closed' | null;
  /** The tab being read has moved to another page since the read began. */
  navigated: boolean;
}

/** Pure so the one piece of real branching here stays testable without a browser. */
export function computeBadge(input: BadgeInput): BadgeState {
  // Outlives playback: the read is over precisely because the tab went away.
  if (input.stopReason === 'tab-closed') return 'stopped-tab-closed';
  // 'preparing' counts — switching tabs while the first chunk synthesizes
  // still leaves the page you asked for in the background.
  const live =
    input.playerState === 'speaking' ||
    input.playerState === 'paused' ||
    input.playerState === 'preparing';
  if (!live) return 'none';
  // Outranks 'background': that page isn't behind another tab, it is gone —
  // and unlike backgrounding this needs no active tab to be true.
  if (input.navigated) return 'navigated';
  if (input.readingTabId === null || input.activeTabId === null) return 'none';
  return input.readingTabId === input.activeTabId ? 'none' : 'background';
}

/** Whether a URL now on the tab being read replaced the document the
 *  transcript came from.
 *
 *  Deliberately conservative — anything it cannot compare answers "no". A
 *  badge claiming the page changed when it didn't is worse than no badge, and
 *  the caller has nothing better to fall back on.
 *
 *  Hash-only differences are the same document: an anchor jump leaves every
 *  word of the transcript exactly where it was. */
export function hasNavigatedAway(
  readUrl: string | undefined,
  currentUrl: string | undefined,
): boolean {
  if (!readUrl || !currentUrl) return false;
  try {
    const a = new URL(readUrl);
    const b = new URL(currentUrl);
    a.hash = '';
    b.hash = '';
    return a.href !== b.href;
  } catch {
    return false;
  }
}

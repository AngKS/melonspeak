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
}

/** What the Now Reading header shows about the tab being read. */
export type BadgeState = 'none' | 'background' | 'stopped-tab-closed';

export interface BadgeInput {
  /** Tab the current read came from; null when unknown or none. */
  readingTabId: number | null;
  /** Active tab of the window hosting the reading view; null when unknown. */
  activeTabId: number | null;
  playerState: PlayerState;
  /** Set when the background stopped the read because that tab closed. */
  stopReason: 'tab-closed' | null;
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
  if (input.readingTabId === null || input.activeTabId === null) return 'none';
  return input.readingTabId === input.activeTabId ? 'none' : 'background';
}

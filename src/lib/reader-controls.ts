import type { PlayerState } from './messages';

/** What the spacebar should do in the Now Reading view right now. */
export type SpaceAction = 'pause' | 'resume' | 'none';

export interface SpaceActionInput {
  playerState: PlayerState;
  /** A focused button, link, or field keeps space as its own activation key —
   *  otherwise Stop, the voice-model menu, and the backgrounded header would
   *  lose the key the browser already gives them. */
  focusIsInteractive: boolean;
}

/** Pure so the view can stay a thin wiring layer, per computeBadge. */
export function resolveSpaceAction(input: SpaceActionInput): SpaceAction {
  if (input.focusIsInteractive) return 'none';
  if (input.playerState === 'speaking') return 'pause';
  if (input.playerState === 'paused') return 'resume';
  // 'preparing', 'loading-model', 'idle' and 'error' have nothing to toggle.
  // The caller must not preventDefault for these, so space still scrolls.
  return 'none';
}

/** Which set of footer controls the panel shows. */
export type FooterMode = 'setup' | 'idle' | 'reading';

/** Pure so the panel can stay a thin wiring layer, per computeBadge.
 *
 *  A live read outranks everything, including a missing model: removing the
 *  last model mid-read would otherwise take the Stop button away while the
 *  audio kept playing. 'setup' then outranks 'idle', because with nothing
 *  installed the only useful action is installing a voice. 'error' falls back
 *  to the read buttons — there is nothing left to pause or stop, and starting
 *  again is how the user retries. */
export function resolveFooterMode(state: PlayerState, hasModel: boolean): FooterMode {
  if (state !== 'idle' && state !== 'error') return 'reading';
  return hasModel ? 'idle' : 'setup';
}

export interface ReadTargetInput {
  /** Active tab of the reading view's window, as the view already tracks it
   *  for the backgrounded badge. */
  activeTabId: number | null;
  /** This view's own tab, when it is rendered as a tab rather than a panel. */
  ownTabId: number | null;
}

/** Which tab a read started from the reading view should target.
 *
 *  The panel is not a tab, so the active tab of its window is the page the
 *  user is looking at — naming it beats letting the background infer one from
 *  `lastFocusedWindow`. `undefined` means "you decide": either nothing is
 *  known yet, or this view *is* the active tab (it is open as a tab), and
 *  reading an extension page is never what was asked for. */
export function resolveReadTarget(input: ReadTargetInput): number | undefined {
  if (input.activeTabId === null) return undefined;
  if (input.activeTabId === input.ownTabId) return undefined;
  return input.activeTabId;
}

/** Whether the transcript should chase the active line in this state.
 *
 *  A finished read is excluded on purpose: scrolling back through it is how
 *  you re-read something, and yanking the view to the last line would fight
 *  that. 'preparing' is included for the same reason the badge includes it —
 *  a read is on its way, and the first line should land in view. */
export function shouldFollowActiveLine(state: PlayerState): boolean {
  return state === 'speaking' || state === 'paused' || state === 'preparing';
}

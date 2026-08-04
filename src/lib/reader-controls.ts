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

/** Whether the transcript should chase the active line in this state.
 *
 *  A finished read is excluded on purpose: scrolling back through it is how
 *  you re-read something, and yanking the view to the last line would fight
 *  that. 'preparing' is included for the same reason the badge includes it —
 *  a read is on its way, and the first line should land in view. */
export function shouldFollowActiveLine(state: PlayerState): boolean {
  return state === 'speaking' || state === 'paused' || state === 'preparing';
}

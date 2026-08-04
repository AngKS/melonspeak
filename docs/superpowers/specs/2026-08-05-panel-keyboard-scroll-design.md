# Spacebar play/pause and scroll-idle snap-back in the Now Reading view

Date: 2026-08-05
Branch: `worktree-panel-keyboard-scroll` (from `658d130`)

## Scope

Two keyboard/scroll affordances for the Now Reading side panel, both local to
that view. No background, player, or manifest changes.

1. **Spacebar toggles play/pause** while the panel has focus.
2. **The transcript returns to the current line** 6 seconds after the user
   stops scrolling elsewhere.

## Decisions

| Question | Decision |
|---|---|
| Space on a finished read | Nothing. Space only toggles `speaking ↔ paused`. Restarting is what click-to-jump is for. |
| Space while a button has focus | The button wins — Space activates it natively. The toggle fires only when focus is elsewhere. |
| Snap-back delay | 6 s of scroll idle. |
| Snap-back when idle/finished | No. Only while `speaking`, `paused`, or `preparing`. |
| What counts as a user scroll | Any scroll of `#lyrics`, not just wheel/touch. |

## Behaviour

### Spacebar

`speaking` → pause. `paused` → resume. Every other state (`preparing`,
`loading-model`, `idle`, `error`) → nothing, and crucially *no*
`preventDefault`, so Space still scrolls the panel when there is nothing to
toggle.

Auto-repeat is ignored, so holding Space does not thrash pause/resume.

**Focus deference.** The panel's controls are real `<button>`s — `#pause`,
`#resume`, `#stop`, `#model-btn`, and the model-menu items — and Space is
already their activation key. The handler stands down whenever

```js
document.activeElement?.closest('button, [role="button"], a, input, select, textarea')
```

matches. This covers the header for free: `renderBadge()` adds
`role="button"`/`tabindex="0"` to `#head` exactly while the read is
backgrounded, and strips them otherwise. So a focused backgrounded header keeps
its return-to-tab Space, and at every other time the header is not focusable at
all and Space toggles playback.

The player already guards `pause` to `speaking` and `resume` to `paused`
(`player.ts:73-84`), so a mis-sent command is inert. The UI still decides
correctly, so Space never `preventDefault`s for a command that would be
swallowed.

### Snap-back

The existing `userScrollUntil` window only gates the scroll *inside*
`setActiveLine`, and `setActiveLine` early-returns when the index is unchanged.
Net effect today: after scrolling away, nothing pulls you back until the player
crosses a chunk boundary — and on a long chunk, or while paused, that never
happens.

The fix separates "which line is active" from "put the active line on screen":

- `scrollActiveLineIntoView()` is extracted from `setActiveLine` and centres the
  active line. Both `setActiveLine` and the new idle timer call it.
- A user scroll sets `userScrollUntil = now + FOLLOW_RESUME_MS` **and** re-arms
  a `FOLLOW_RESUME_MS` timer.
- When the timer fires, if `shouldFollowActiveLine(state)` and a line is active,
  the view scrolls it back to centre. One shot per scroll burst; ordinary
  chunk-advance auto-scroll resumes on its own because the window has expired.

`FOLLOW_RESUME_MS = 6000` replaces the current hard-coded `4000`.

**Detecting user scrolls.** Today only `wheel` and `touchmove` are listened
for, so a scrollbar drag or PageDown does not register — auto-scroll fights
those today, and they would get no snap-back either. Replaced by a `scroll`
listener on `#lyrics` plus an ~800 ms suppression window set around the view's
own `scrollTo`, so every scroll method behaves the same. A smooth scroll that
outruns the window can re-arm the timer, which resolves to a no-op re-centre on
the line already centred.

## Architecture

Following the `reading-tab.ts` / `computeBadge` precedent — the branching lives
in a pure, testable function; the view only wires it up.

New `src/lib/reader-controls.ts`:

```ts
export type SpaceAction = 'pause' | 'resume' | 'none';

export interface SpaceActionInput {
  playerState: PlayerState;
  /** A focused button/link/field keeps Space as its own activation key. */
  focusIsInteractive: boolean;
}

export function resolveSpaceAction(input: SpaceActionInput): SpaceAction;

/** Whether the transcript should chase the active line in this state. */
export function shouldFollowActiveLine(state: PlayerState): boolean;
```

`src/reader/reader.ts` gains a `document` `keydown` listener and the idle
timer, and swaps its `wheel`/`touchmove` listeners for the `scroll` listener.
Nothing else in the file changes shape.

## Testing

`scripts/test.mjs` gains `reader-controls` as an entry point and covers:

- `resolveSpaceAction` across all six player states with focus elsewhere.
- Interactive focus suppresses the action in every state, including `speaking`
  and `paused`.
- `shouldFollowActiveLine` true for `speaking`/`paused`/`preparing`, false for
  `idle`/`loading-model`/`error`.

The keydown and scroll wiring is DOM-bound and not unit-testable in this
harness; it is verified by loading the dev build and driving the panel.

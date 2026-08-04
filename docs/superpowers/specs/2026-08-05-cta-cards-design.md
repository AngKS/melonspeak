# Call-to-action cards for the idle Now Reading view

Date: 2026-08-05
Branch: `worktree-cta-cards` (from `main` @ `dabbc48`)

## Scope

When nothing is playing, the reading view is a dead end: a line of grey text
telling you to go use a *different* surface (the popup, or the right-click
menu). This replaces that with two things you can act on where you already
are — read this page, or read what you have highlighted — and makes the
highlight card show the actual highlighted text.

Out of scope: changing how extraction, chunking or playback work. The cards are
new entry points into the existing `read-page` / `read-selection` paths.

## Decisions

| Question | Decision |
|---|---|
| Page access | `host_permissions: ["<all_urls>"]` in both manifests. `activeTab` cannot serve a sidepanel (below). |
| Seeing the highlight | A watcher content script injected on demand, reporting over a `runtime.Port`. Not polling, not a declared content script. |
| Which panel states show cards | Idle-with-nothing (`full`), and after a read finishes or its tab closed (`compact`, under the dimmed transcript). |
| Card content | Read-page card carries the live tab title; highlight card carries a 3-line quote, word count and duration estimate. |
| Repeating a finished read | A third card, in `compact` only, replaying the transcript already in memory. |
| What actually gets read | Re-extracted from the page on click. The card preview is never the payload. |
| Highlights inside iframes | Not detected. Matches how `extract.ts` already reads selections. |

## Why `activeTab` cannot serve this

Chrome grants `activeTab` on exactly four gestures: executing an action,
executing a context menu item, a `commands` keyboard shortcut, and accepting an
omnibox suggestion. Opening or clicking inside the side panel is none of them.

Today that is invisible, because every path that reads a page starts at the
popup (an action click) or the context menu, each of which grants access to the
tab as a side effect. A button *inside the panel* has no such gesture behind it,
so `chrome.scripting.executeScript` would throw on any tab the user had not
already poked — and `readTab()` swallows that throw and reports "This page
cannot be read (browser-restricted page)", which would be a lie.

So the panel gets real host permissions or it gets no buttons.

### The Firefox half

Firefox MV3 treats `host_permissions` as opt-in rather than install-time. The
panel therefore checks `chrome.permissions.contains({origins: ['<all_urls>']})`
on load and renders a third card state — **needs-access** — when it comes back
false. Clicking that card calls `chrome.permissions.request()` inside the click
gesture; if Firefox refuses (it has historically been strict about which
contexts may request), the card falls back to naming `about:addons` so the user
has somewhere to go. On Chrome `contains()` is true at install and none of this
is reachable.

## Architecture

### `src/lib/cta-state.ts` — the branching, made testable

Following `lib/reading-tab.ts`: the one piece of real branching lives in a pure
function so it can be asserted without a browser.

```ts
computeCtaView({ playerState, hasLines, stopReason }): 'hidden' | 'full' | 'compact'
```

| Situation | Result | Reason |
|---|---|---|
| `speaking`, `paused`, `loading-model` | `hidden` | The lyrics own the panel. |
| `preparing` | `hidden` | Something is on its way; today's view already suppresses the empty state here, and a CTA would invite a second request that cancels the first. |
| `idle` or `error`, lyrics present | `compact` | The read finished. Keep the transcript — it is still clickable to replay from a line — and offer what's next underneath. |
| `idle` or `error`, no lyrics | `full` | The state in the screenshot that started this. |
| `stopReason === 'tab-closed'` | `compact` | Transcript is the only record of what was read; it stays. |

`summarizeSelection(text, speed)` is the other pure piece: it clamps the quote,
counts words, and turns them into a duration at 165 wpm scaled by the user's
saved speed.

### `src/content/selection-watch.ts` — a watcher with a lifetime

Injected into the active tab only while the cards are on screen, and torn down
when they aren't. The mechanism that makes the teardown automatic is the port:

1. The panel injects the file and the script calls `arm()`.
2. `arm()` opens `chrome.runtime.connect({ name: SELECTION_PORT })` and starts
   listening to `selectionchange`, debounced 200 ms.
3. When the panel closes — or leaves the CTA state, or switches tabs — the port
   disconnects. The script sees `onDisconnect`, removes its listener, and drops
   back to dormant so a later injection can re-arm it.

This is why it is a port and not `sendMessage`: a fire-and-forget watcher has no
way to learn that nobody is listening any more, and would keep running on every
page the user visited for the rest of that tab's life.

Only `{ preview, words, chars }` crosses the boundary — the preview capped at
240 characters. A 100 KB highlight stays in the page where it already is.

`arm()` is idempotent (returns early if a port is open) because
`executeScript` re-runs the file top-to-bottom on every injection.

### Reader view

`#empty` becomes `#cta`, holding two real `<button>` elements — keyboard
support and screen-reader semantics for free, which the old `<div>` empty state
had no need of.

**Read this page** shows the active tab's title as its subtitle, refreshed on
`tabs.onActivated` and `tabs.onUpdated`. On a URL no extension can script
(`chrome://`, `about:`, `moz-extension://`, the Web Store) it renders disabled
with "This page can't be read" — refusing up front instead of letting the click
land in the generic error.

**Read highlighted text** is `disabled` with a dashed border until a selection
arrives, then fills with the quote and metrics, switches to a solid green-tinted
border, and pulses once. The pulse is behind `prefers-reduced-motion`.

**Read this again** appears only in `compact`, and only while `chunkStrings`
still holds a transcript. It re-speaks that retained text rather than
re-extracting the page, which is what makes it work after the source tab has
been closed — the `⊘ PAGE CLOSED` state can still replay what it was reading.
In `compact` it takes the primary red and the page card steps back to neutral,
since repeating what you just heard is the likelier intent than starting the
page over.

Its subtitle is deliberately *not* the title: the header carries that two
lines above, and the page card often carries it too, so three identical
subtitles would say nothing. It describes the transcript instead — "From the
top · 3 lines".

Both read cards send their existing background message with an explicit
`tabId`, so the panel targets the active tab of *its own* window rather than
having the background re-derive one from `lastFocusedWindow`.

Two fixes to the stale state visible in the screenshot: in `full` mode the
header resets to "MelonSpeak" under a `READY` eyebrow instead of holding the
last article's title under "NOW READING", and the "press Read page in the
MelonSpeak popup" paragraph shrinks to a one-line footnote about the
right-click menu.

## Testing

- `scripts/test.mjs` gains assertions for `computeCtaView` across every row of
  the table above, and for `summarizeSelection` (clamping, word counting,
  speed scaling, empty input).
- `scripts/smoke.mjs` gains a case that serves a fixture page over local http,
  highlights it, and asserts the card lights up with the right quote and word
  count, goes dormant when the selection clears, and that a finished read
  yields the compact layout with the replay card.

One trap worth recording: in that smoke test the reading view is a *background*
tab, because the fixture has to be the active one for the view to look at it.
Background tabs do not advance CSS transitions, so a card mid-transition
freezes at its old colour and `getComputedStyle` reports it. Assert on classes,
`disabled` and text — never on colours — unless the view has been brought to
the front first.

## Known limitations

- Selections inside iframes are not seen (main frame only).
- The word count comes from the raw selection; the spoken text is normalised
  afterwards, so the duration estimate is approximate by design.

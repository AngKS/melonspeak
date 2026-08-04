# Backgrounded-tab badge for the Now Reading sidebar

Date: 2026-08-05
Branch: `badge-on-main` (grafted onto `330e171`)

## Scope

Sidebar auto-open and "closing the tab stops the read" already landed in
`330e171`. This adds the half that was missing: while a read is playing, the
reading view shows whether the page it is reading is still in front of you, and
gets you back there in one click.

## Decisions

| Question | Decision |
|---|---|
| "Backgrounded" means | The tab being read is not the active tab in the sidebar's window. Window focus is ignored. |
| Source tab closed mid-read | Stop the read (already implemented) and *explain* it in the view. |
| Badge placement | Chip on the eyebrow row; the whole header becomes the click target. No extra vertical space. |
| Sidebar after a tab-close stop | `STOPPED` + `⊘ PAGE CLOSED`, transcript kept on screen but dimmed. |

## Architecture

### storage.session is the source of truth — not a broadcast

The background already stored the tab being read in `chrome.storage.session` so
an evicted MV3 worker could still recognise it in `tabs.onRemoved`. The reading
view needs the same value.

The obvious design — the view sends `get-reading-tab`, the background reads
storage and broadcasts the answer — **does not work reliably**, and the smoke
test caught it as a hard 3-second timeout:

> Chrome may tear the MV3 service worker down the moment an `onMessage`
> listener returns synchronously. Anything queued after an `await` inside that
> listener — including `storage.session.get().then(broadcast)` — is simply
> dropped.

A two-sided probe confirmed the shape: service-worker → page messages arrived
fine, but the reply to `get-reading-tab` never did. An earlier iteration of this
work used the same async shape and passed only by luck; it was a race, not a
correct implementation.

The fix removes the round-trip entirely. Extension pages are TRUSTED_CONTEXTS,
so the reading view reads `chrome.storage.session` directly and subscribes to
`chrome.storage.onChanged` filtered to `area === 'session'`. No runtime message,
no dependence on the worker being alive.

Shared contract lives in `src/lib/reading-tab.ts`:

```ts
export const READING_TAB_KEY = 'readingTab';
export interface ReadingTabState {
  tabId: number | null;
  reason?: 'tab-closed';
}
```

Written only by the background (`setReadingTab`). The `reason` rides inside the
stored object, which is what lets the view know *why* playback stopped before
`stopAll()`'s empty-transcript broadcast (`player.ts:127`) arrives and would
otherwise wipe the lyrics with nothing left to explain the silence. The
`tabs.onRemoved` handler therefore records the reason **before** delivering
`stop`.

### Badge state is a pure function

`computeBadge({ readingTabId, activeTabId, playerState, stopReason })` →
`'none' | 'background' | 'stopped-tab-closed'`, in `src/lib/reading-tab.ts`,
unit-tested in `scripts/test.mjs`. `preparing` counts as live alongside
`speaking`/`paused`: switching tabs while the first chunk synthesizes still
leaves the requested page in the background.

### Reader

Display-only; it holds no behavior beyond navigation. Tracks `myWindowId`,
`activeTabId`, `readingTabId`, `stopReason`, and subscribes to
`tabs.onActivated` filtered to its own window.

```html
<header id="head">
  <p id="eyebrow-row">
    <span id="eyebrow">NOW READING</span>
    <span id="bg-badge" hidden></span>
  </p>
```

`role="button"`/`tabindex` are added and removed with the clickable state, so
the header never sits in the tab order advertising an action it won't perform.
A real `<button>` is impossible here because the header wraps an `<h1>`;
Enter/Space are handled explicitly. Clicking calls
`tabs.update(id, {active: true})`, then `windows.update` if the tab has since
been dragged to another window.

No new permissions: the id-only data needed from `tabs.query` / `onActivated` /
`update` requires none.

## Testing

- `npm test` — six `computeBadge` cases.
- `npm run smoke` — drives the badge end to end through its real channels:
  writes `storage.session` from the service worker, broadcasts a `speaking`
  status, and asserts the badge appears and the header becomes clickable; then
  writes the `tab-closed` state and asserts `STOPPED` / `⊘ PAGE CLOSED` with the
  header no longer interactive.
- Manual: Chrome side panel and Firefox sidebar cannot be driven headlessly.
  Needs a human pass for auto-open, badge on tab switch, and click-to-return.

## Files

New: `src/lib/reading-tab.ts`

Edited: `src/background.ts`, `src/lib/messages.ts`, `src/onboarding/onboarding.ts`,
`src/reader/reader.{ts,html,css}`, `scripts/test.mjs`, `scripts/smoke.mjs`,
`README.md`

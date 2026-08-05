# The side panel owns every setting and control; the popup goes away

Date: 2026-08-05
Branch: `worktree-panel-owns-controls` (from `8721400`)

## Scope

Move every setting and control the action popup owns into the Now Reading
panel, and make the toolbar icon open that panel. `src/popup/` is deleted.
Model *downloading* is out of scope and stays in the onboarding tab.

Touches: both manifests, `background.ts`, `reader/` (html, css, ts), the build
script, and the test/smoke scripts. The player, engines, and extraction are
untouched.

## Decisions

| Question | Decision |
|---|---|
| Popup's fate | Deleted. The toolbar icon opens the panel. |
| Where no sidebar API exists | `reader.html` itself becomes the action popup — one UI, not a second implementation. |
| Layout of the migrated controls | Reading view keeps the panel; model/voice/speed live in a sheet behind a **☰** header button. |
| Starting a read while one plays | A split **▶ Read this page ▾** button beside the transport; the ▾ menu also offers *Read highlighted text*. |
| Model downloads / removal | Stay in the onboarding tab. The sheet links to it via *Manage voices…*. |
| First run after install | Still opens the onboarding tab — neither browser lets an extension open a panel without a user gesture. |

## Surfaces

`reader/reader.html` renders in three contexts:

- **Side panel** — Chrome, via `side_panel.default_path` (already configured).
- **Sidebar** — Firefox, via `sidebar_action.default_panel` (already configured).
- **Action popup** — only where neither API exists.

It also still opens as a plain tab; nothing in the UI links there any more, but
the URL keeps working.

`onboarding/` is unchanged.

## Toolbar icon

Both manifests drop `action.default_popup`. The background resolves which
surface it has and wires it at every worker/event-page start — not only on
install, because an MV3 service worker is torn down and restarted constantly and
this is idempotent:

| Surface | Wiring |
|---|---|
| `side-panel` | `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`. Chrome then opens the panel itself and `action.onClicked` never fires. |
| `sidebar` | `chrome.action.onClicked` → `browser.sidebarAction.toggle()`. `onClicked` is a user-input handler, which is what Firefox requires. Toggle, not open, so a second click closes it. |
| `popup` | `chrome.action.setPopup({ popup: 'reader/reader.html?surface=popup' })`. |

The choice is a pure function so it can be tested without a browser:

```ts
// src/lib/action-surface.ts
export type ActionSurface = 'side-panel' | 'sidebar' | 'popup';
export function resolveActionSurface(caps: {
  hasSidePanel: boolean;
  hasSidebarAction: boolean;
}): ActionSurface;
```

`side-panel` wins when both are present. Applying the result stays in
`background.ts`, which is the only context holding those APIs.

### Why the query parameter

Popups size to content, so `reader.css`'s `html, body { height: 100% }`
collapses to nothing there. `?surface=popup` lets the page tag itself
(`document.documentElement.classList.add('as-popup')`) and the stylesheet pin a
real box: `html.as-popup { width: 360px; height: 560px }`. Nothing else in the
page branches on the surface.

## Panel layout

**Header** — logo, eyebrow + background badge, title, and a **☰** button on the
right. The header keeps its existing `role="button"` return-to-tab behaviour;
☰ is a real `<button>` outside that region, so the two do not collide.

**Body** — visualizer and lyrics, unchanged.

**Footer** — one of three modes, chosen by a pure helper added to the existing
`lib/reader-controls.ts`:

```ts
export type FooterMode = 'setup' | 'idle' | 'reading';
export function resolveFooterMode(state: PlayerState, hasModel: boolean): FooterMode;
```

- **`setup`** (no model installed, nothing playing) — "Download a voice model to
  start listening" and a **Finish setup** button opening the onboarding tab.
- **`idle`** — nothing. See *Reconciling with the CTA cards* below.
- **`reading`** (`speaking`, `paused`, `preparing`, `loading-model`) —
  `⏸`/`▶` and `⏹`, then a split **▶ Read this page ▾**. The ▾ menu holds
  *Read this page* and *Read highlighted text*. Choosing either replaces the
  running read, which is what the popup's buttons already did.

Under the footer, a static meta line: `Kokoro · Heart · 1.0×` on the left,
`100% offline` on the right. It is the at-a-glance readout the popup's visible
selects used to provide.

`error` keeps today's treatment — the eyebrow shows `⚠ detail` — and the footer
falls back to `idle` so the user can retry.

### Reconciling with the CTA cards

`worktree-cta-cards` landed on main during implementation, adding cards to the
panel's idle area — *Read this page* with the live tab title, *Read highlighted
text* with a live quote and duration, and *Read this again* to replay. Those
answer the same question as this design's idle footer buttons, with more
information, so the cards keep the idle slot and the footer's `idle` mode shows
nothing at all. The footer still owns what cards cannot: `computeCtaView`
returns `hidden` for every playing state, so the split **▶ Read this page ▾** is
the only way to start a new read without stopping the current one.

That branch also carried `host_permissions: ["<all_urls>"]`, which this design
needed and did not have. Chrome grants `activeTab` on an action click, a context
menu item, a `commands` shortcut, or an omnibox pick — clicking inside a side
panel is none of them, so `executeScript` throws for any tab the user has not
already poked and `readTab()` reports it as a browser-restricted page. Panel
reads do not work without the host permission.

## The ☰ sheet

Slides up from the bottom of the panel over the lyrics. Dismissed by clicking
outside it, by Esc, or by pressing ☰ again; `aria-expanded` tracks its state.
Contents, top to bottom:

1. **Voice model** — the installed models, short name over real name, ✓ on the
   current one. This absorbs today's `#model-bar` / `#model-menu`, which is
   removed from the footer.
2. **Voice** — shown only when the selected model has two or more voices.
3. **Speed** — 0.5–2.0 range plus its `1.0×` label.
4. **Manage voices…** — opens the onboarding tab.

Behaviour carried over verbatim from the popup and today's model menu:

- Changing the **model** mid-read re-speaks the remainder from the active line
  (`speak` with `chunkStrings.slice(from)`); otherwise it sends `model-changed`
  to free the previous engine.
- Changing the **voice** sends `set-voice`, which retargets an in-progress read
  rather than killing it.
- Changing the **speed** persists on `change` and sends `set-speed`; the label
  updates live on `input`.

Space is already deferred to focused `button`, `input`, and `select` elements by
`resolveSpaceAction`, so the sheet's controls keep their native Space behaviour
with no new code.

## Code shape

`reader.ts` is 530 lines before this change, so the migrated controls land
beside it rather than inside it:

| File | Responsibility |
|---|---|
| `src/reader/reader.ts` | Transcript, visualizer, background badge, status routing. Loses the model bar. |
| `src/reader/settings-menu.ts` | The ☰ sheet: model list, voice, speed, Manage voices. |
| `src/reader/read-actions.ts` | Footer modes: read buttons, split button, transport. |
| `src/lib/action-surface.ts` | `resolveActionSurface` (new, pure). |
| `src/lib/reader-controls.ts` | Gains `resolveFooterMode` (pure). |

Each new module exports an `init`-style entry taking the elements it owns and a
`sendPlayerCmd` callback, so `reader.ts` stays the wiring layer and neither
module reaches into the other's DOM.

### Logic that must move, not be dropped

The popup verifies installed models against disk on open — `installedModels()`
from `engines/model-storage.ts`, reporting differences to the background as an
`installed-state` message. Without it an evicted cache or a half-finished
download leaves a model in the picker that cannot speak a word. This
reconciliation moves into `reader.ts`'s init, which is now the surface that
opens on every toolbar click.

## Deliberately dropped

- The popup's progress bar. The lyrics and the highlighted active line are a
  better progress display, and the panel always shows them.
- The **Now Reading view** button. The panel is that view.
- The popup's duplicated now-reading title line; the panel header has it.
- The popup's `openSidebar()` calls. `lib/sidebar.ts` keeps the function and
  `primeSidebar()`'s window-id cache regardless: `contextMenus.onClicked` opens
  the sidebar for a tab, and the onboarding tab's per-model **try it** button
  opens it without one.

## Build

`scripts/build.mjs` drops the `popup/popup` entry point and `popup` from the
page-copy list. The two new `reader/` modules need no entry points of their own
— `reader.ts` imports them and esbuild bundles them in. `src/popup/` is deleted.

## Testing

**Unit** (`scripts/test.mjs`, which bundles the module under test):

- `resolveActionSurface` — both APIs → `side-panel`; sidebar only → `sidebar`;
  neither → `popup`.
- `resolveFooterMode` — `speaking`/`paused`/`preparing`/`loading-model` →
  `reading` whether or not a model is installed (removing the last model
  mid-read must not take Stop away); `idle`/`error` → `idle` with a model,
  `setup` without one.
- `resolveReadTarget` — names the active tab; defers when it would name itself
  or knows no tab.

**Smoke** (`scripts/smoke.mjs`, real Chrome for Testing):

- The built manifest's `action` has no `default_popup`, and `side_panel` is
  still present.
- On a fresh profile `reader.html` shows the setup CTA rather than read buttons.
- ☰ opens the sheet and lists the installed models; the speed slider reflects
  stored settings.
- The read buttons exist and are enabled once a model is installed.
- After removing the last model, the panel returns to the setup CTA (today's
  equivalent popup assertion).

**Firefox smoke** — the same panel assertions, plus `sidebar_action` intact and
no `default_popup`.

`verify-read.mjs` retargets its popup transport assertion to `reader.html`.

### The panel names the tab, rather than the background inferring it

The original plan left `readActiveTab()` to resolve the target with
`tabs.query({ active: true, lastFocusedWindow: true })` and have the smoke run
assert that a panel click lands on the content tab. That assertion turned out
to be unautomatable: puppeteer has no way to open a real Chrome side panel, so
the test would have exercised `reader.html` in a *tab* — where the reading view
is itself the active tab, which is not the case under test.

Rather than ship an untestable assumption, the panel states its target. A new
pure helper decides what to send:

```ts
// src/lib/reader-controls.ts
export function resolveReadTarget(input: {
  activeTabId: number | null;
  ownTabId: number | null;
}): number | undefined;
```

The reading view already tracks its window's active tab for the backgrounded
badge; it also asks `tabs.getCurrent()` for its own tab id, which is `null` in a
panel or popup and set only when it is open as a tab. `read-page` and
`read-selection` carry the resulting `tabId` when there is one, and the
background prefers it over the active-tab query, which remains the fallback for
the context menu and for a view that would otherwise target itself.

The unit tests cover all three cases; the smoke run covers the wiring.

// The "Now Reading" view: live audio visualizer + Apple Music-style lyrics
// (auto-scrolling, current line highlighted, neighbors faded/blurred).
import { SELECTION_PORT, VIZ_PORT } from '../lib/messages';
import type {
  Message,
  ModelId,
  PlayerCommand,
  PlayerStatus,
  SelectionMessage,
  VizMessage,
} from '../lib/messages';
import type { BadgeState, ReadingTabState } from '../lib/reading-tab';
import { READING_TAB_KEY, computeBadge } from '../lib/reading-tab';
import {
  resolveReadTarget,
  resolveSpaceAction,
  shouldFollowActiveLine,
} from '../lib/reader-controls';
import { computeCtaView, formatDuration, isReadableUrl } from '../lib/cta-state';
import type { Settings } from '../lib/settings';
import { getSettings, mutateSettings, onSettingsChanged } from '../lib/settings';
import { MODEL_IDS } from '../engines/registry';
import { installedModels } from '../engines/model-storage';
import { initReadActions, requestRead } from './read-actions';
import { initSettingsMenu } from './settings-menu';

// The fallback surface pins its own size; see reader.css. Nothing else in the
// page branches on where it is rendered.
if (new URLSearchParams(location.search).get('surface') === 'popup') {
  document.documentElement.classList.add('as-popup');
}

const lyricsEl = document.getElementById('lyrics') as HTMLElement;
const ctaEl = document.getElementById('cta') as HTMLElement;
const pageCard = document.getElementById('cta-page') as HTMLButtonElement;
const pageSubEl = document.getElementById('cta-page-sub') as HTMLElement;
const selectionCard = document.getElementById('cta-selection') as HTMLButtonElement;
const selectionSubEl = document.getElementById('cta-selection-sub') as HTMLElement;
const selectionQuoteEl = document.getElementById('cta-selection-quote') as HTMLElement;
const selectionMetaEl = document.getElementById('cta-selection-meta') as HTMLElement;
const replayCard = document.getElementById('cta-replay') as HTMLButtonElement;
const replaySubEl = document.getElementById('cta-replay-sub') as HTMLElement;
const titleEl = document.getElementById('title') as HTMLElement;
const eyebrowEl = document.getElementById('eyebrow') as HTMLElement;
const headEl = document.getElementById('head') as HTMLElement;
const badgeEl = document.getElementById('bg-badge') as HTMLElement;
const navToastEl = document.getElementById('nav-toast') as HTMLElement;
const navToastTextEl = document.getElementById('nav-toast-text') as HTMLElement;
const navToastReadEl = document.getElementById('nav-toast-read') as HTMLButtonElement;
const navToastCloseEl = document.getElementById('nav-toast-close') as HTMLButtonElement;
const canvas = document.getElementById('viz') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

let lines: HTMLElement[] = [];
/** Raw chunk text, kept so a model switch can re-speak the remainder. */
let chunkStrings: string[] = [];
let activeIndex = -1;
let userScrollUntil = 0;
let transcriptKey = '';
let lastStatus: PlayerStatus | null = null;

/** Tab being read; owned by the background, mirrored here for the badge. */
let readingTabId: number | null = null;
/** Active tab of *this* view's window. Null in a context without one. */
let activeTabId: number | null = null;
/** This view's own tab, set only when it is rendered as a tab. A panel and a
 *  popup have no tab of their own, which is what makes the active tab theirs
 *  to read. */
let myTabId: number | null = null;
/** Only populated where a host permission matches the tab, which is exactly
 *  where the cards can do anything — so "missing" and "unreadable" coincide. */
let activeTabTitle: string | undefined;
let activeTabUrl: string | undefined;
let myWindowId: number | null = null;
/** Set when the background ended the read because the tab closed. */
let stopReason: 'tab-closed' | null = null;
/** That tab has moved to another page since the read began; what is on screen
 *  came from a document that is no longer there. */
let readingTabNavigated = false;
/** Where it moved to, so a second link click reads as a new offer rather than
 *  a repeat of the one already made. */
let readingTabMovedTo: string | undefined;
/** Last rendered badge, so the toast can ask what the header already decided
 *  rather than re-deriving liveness from the status. */
let badgeState: BadgeState = 'none';

function sendPlayerCmd(cmd: PlayerCommand): void {
  void chrome.runtime
    .sendMessage({ target: 'background', type: 'player-cmd', cmd } satisfies Message)
    .catch(() => {});
}

function openOnboarding(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
}

/** Models verified present on disk. Drives both the footer mode and the ☰
 *  model list, so neither can offer a voice that cannot speak a word. */
let installedIds: ModelId[] = [];

const readActions = initReadActions({
  sendPlayerCmd,
  openOnboarding,
  readTargetTabId: () => resolveReadTarget({ activeTabId, ownTabId: myTabId }),
});
const settingsMenu = initSettingsMenu({
  sendPlayerCmd,
  openOnboarding,
  onModelChosen: (id) => void chooseModel(id),
});

function renderFooter(): void {
  readActions.update(lastStatus?.state ?? 'idle', installedIds.length > 0);
}

/** Elements the browser already activates with space. The header is covered
 *  through role=button, which renderBadge() adds only while it is actionable. */
const INTERACTIVE_SELECTOR = 'button, [role="button"], a, input, select, textarea';

document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.repeat) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const focused = document.activeElement;
  const action = resolveSpaceAction({
    playerState: lastStatus?.state ?? 'idle',
    focusIsInteractive: focused instanceof Element && focused.closest(INTERACTIVE_SELECTOR) !== null,
  });
  // Nothing to toggle: leave the event alone so space still scrolls, and so a
  // focused control keeps its own activation.
  if (action === 'none') return;
  e.preventDefault();
  sendPlayerCmd({ type: action });
});

// -- Reading tab: backgrounded badge + click-to-return -----------------------
// Display only. Stopping the read when that tab closes is the background's
// job, so it still happens with the sidebar shut.

function renderBadge(): void {
  const state = (badgeState = computeBadge({
    readingTabId,
    activeTabId,
    playerState: lastStatus?.state ?? 'idle',
    stopReason,
    navigated: readingTabNavigated,
  }));
  badgeEl.hidden = state === 'none';
  if (state === 'background') {
    badgeEl.textContent = '⤴ BACKGROUND';
    badgeEl.className = 'badge backgrounded';
  } else if (state === 'navigated') {
    badgeEl.textContent = '⤴ PAGE CHANGED';
    badgeEl.className = 'badge changed';
  } else if (state === 'stopped-tab-closed') {
    badgeEl.textContent = '⊘ PAGE CLOSED';
    badgeEl.className = 'badge closed';
    // Overrides the 'FINISHED' renderStatus leaves on an idle player — the
    // read didn't finish, the page went away.
    eyebrowEl.textContent = 'STOPPED';
  }
  // The offer outlives neither the fact behind it nor the read it belongs to.
  if (state !== 'navigated') hideNavToast();
  // Button semantics come and go with the state, so the header never sits in
  // the tab order advertising an action it won't perform.
  const clickable = state === 'background';
  headEl.classList.toggle('clickable', clickable);
  if (clickable) {
    headEl.setAttribute('role', 'button');
    headEl.setAttribute('tabindex', '0');
    headEl.setAttribute('aria-label', 'Return to the page being read');
  } else {
    headEl.removeAttribute('role');
    headEl.removeAttribute('tabindex');
    headEl.removeAttribute('aria-label');
  }
}

async function returnToReadingTab(): Promise<void> {
  if (readingTabId === null || !headEl.classList.contains('clickable')) return;
  try {
    await chrome.tabs.update(readingTabId, { active: true });
    // The tab may have been dragged into another window since the read began.
    const tab = await chrome.tabs.get(readingTabId);
    if (tab.windowId !== myWindowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // Tab vanished between render and click; the background will correct us.
  }
}

headEl.addEventListener('click', () => void returnToReadingTab());
headEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  void returnToReadingTab();
});

// -- "This tab moved" toast -------------------------------------------------
// The chip states the fact for as long as it holds; this carries only the
// offer, so it is transient and raised on the transition alone. A panel opened
// long after a navigation gets the chip and no interruption.

const NAV_TOAST_MS = 7000;
let navToastTimer: ReturnType<typeof setTimeout> | undefined;

function setNavToastTitle(title: string | undefined): void {
  navToastTextEl.textContent = title
    ? `This tab moved to “${title}”`
    : 'This tab moved to another page';
}

function showNavToast(): void {
  const tabId = readingTabId;
  setNavToastTitle(undefined);
  navToastEl.hidden = false;
  clearTimeout(navToastTimer);
  navToastTimer = setTimeout(hideNavToast, NAV_TOAST_MS);
  if (tabId === null) return;
  // Best effort: the new title may not have landed yet, in which case the
  // onUpdated listener below fills it in while the toast is still up.
  void chrome.tabs
    .get(tabId)
    .then((tab) => {
      if (tabId === readingTabId && !navToastEl.hidden) setNavToastTitle(tab.title);
    })
    .catch(() => {});
}

function hideNavToast(): void {
  navToastEl.hidden = true;
  clearTimeout(navToastTimer);
  navToastTimer = undefined;
}

navToastReadEl.addEventListener('click', () => {
  // The tab that moved, not the active one: the panel may well be in front of
  // a different tab by now, and this offer was about that page.
  const tabId = readingTabId;
  hideNavToast();
  if (tabId !== null) requestRead('page', tabId);
});
navToastCloseEl.addEventListener('click', hideNavToast);

/** Guards against a slow tabs.get for tab A landing after the user has
 *  already moved to tab B. */
let activeTabSeq = 0;

async function setActiveTab(tabId: number | null): Promise<void> {
  const seq = ++activeTabSeq;
  activeTabId = tabId;
  activeTabTitle = undefined;
  activeTabUrl = undefined;
  // The watcher must let go of the old tab immediately. The card, by
  // contrast, is left showing the outgoing page for the millisecond or two
  // tabs.get takes — flashing "this page can't be read" at every tab switch
  // would be worse than being briefly out of date.
  tabResolved = false;
  renderBadge();
  syncSelectionWatch();
  if (tabId === null) {
    tabResolved = true;
    renderPageCard();
    return;
  }
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    // Tab closed while we asked.
  }
  if (seq !== activeTabSeq) return; // a newer switch already won
  activeTabTitle = tab?.title;
  activeTabUrl = tab?.url;
  tabResolved = true;
  renderPageCard();
  syncSelectionWatch();
}

chrome.tabs.onActivated.addListener((info) => {
  if (myWindowId !== null && info.windowId !== myWindowId) return;
  void setActiveTab(info.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // The toast is raised on a URL change, and the title of what that URL
  // loaded arrives after it.
  if (tabId === readingTabId && changeInfo.title !== undefined && !navToastEl.hidden) {
    setNavToastTitle(changeInfo.title);
  }
  if (tabId !== activeTabId) return;
  if (changeInfo.url !== undefined || changeInfo.title !== undefined) {
    activeTabUrl = tab.url;
    activeTabTitle = tab.title;
    renderPageCard();
  }
  // A finished navigation replaced the document the watcher was living in.
  if (changeInfo.status === 'complete') {
    stopSelectionWatch();
    syncSelectionWatch();
  }
});

function applyReadingTab(state: ReadingTabState | undefined, fromChange = false): void {
  const wasNavigated = readingTabNavigated;
  const wasMovedTo = readingTabMovedTo;
  readingTabId = state?.tabId ?? null;
  readingTabNavigated = state?.navigated === true;
  readingTabMovedTo = state?.movedTo;
  // Set before the player's empty-transcript broadcast can land — that
  // ordering is what lets setTranscript() know to keep the lyrics.
  stopReason = state?.reason === 'tab-closed' ? 'tab-closed' : null;
  lyricsEl.classList.toggle('stopped', stopReason === 'tab-closed');
  renderView();
  renderBadge();
  // renderBadge has just weighed liveness for us: 'navigated' means there is
  // a read this offer can still replace. Each destination gets its own offer;
  // anything else about the record changing does not.
  const newDestination = !wasNavigated || readingTabMovedTo !== wasMovedTo;
  if (fromChange && newDestination && badgeState === 'navigated') showNavToast();
}

// storage.session is the source of truth, so a sidebar opened mid-read gets
// the current value and every later change without depending on the
// background worker being alive to tell it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[READING_TAB_KEY]) return;
  applyReadingTab(changes[READING_TAB_KEY].newValue as ReadingTabState | undefined, true);
});

async function loadReadingTab(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(READING_TAB_KEY);
    applyReadingTab(stored[READING_TAB_KEY] as ReadingTabState | undefined);
  } catch {
    // No session storage; the badge stays hidden.
  }
}

async function initTabTracking(): Promise<void> {
  try {
    const self = await chrome.tabs.getCurrent();
    myTabId = self?.id ?? null;
  } catch {
    // Not a tab (panel or popup), which is the common case.
  }
  try {
    const win = await chrome.windows.getCurrent();
    myWindowId = win.id ?? null;
    const [tab] = await chrome.tabs.query(
      myWindowId !== null
        ? { active: true, windowId: myWindowId }
        : { active: true, currentWindow: true },
    );
    await setActiveTab(tab?.id ?? null);
  } catch {
    // No window context; the badge stays hidden rather than guessing.
    renderBadge();
  }
}

// -- Transcript / lyrics ----------------------------------------------------

function setTranscript(chunks: string[] | null, title?: string): void {
  // stopAll() broadcasts an empty transcript. After a tab-close stop we keep
  // the lyrics on screen, dimmed, so "STOPPED / ⊘ PAGE CLOSED" has something
  // to explain instead of an empty panel.
  if (stopReason === 'tab-closed' && (!chunks || chunks.length === 0)) return;
  // A real transcript means a new read has begun; the stopped state is over.
  if (chunks && chunks.length > 0 && stopReason !== null) {
    stopReason = null;
    lyricsEl.classList.remove('stopped');
  }
  // Status and transcript arrive on separate channels; don't rebuild (and
  // lose the active-line highlight) for a transcript we already show.
  const key = chunks
    ? `${chunks.length}:${title ?? ''}:${chunks[0] ?? ''}:${chunks[chunks.length - 1] ?? ''}`
    : '';
  if (key === transcriptKey) return;
  transcriptKey = key;
  lyricsEl.replaceChildren();
  lines = [];
  chunkStrings = chunks ? [...chunks] : [];
  activeIndex = -1;
  if (!chunks || chunks.length === 0) {
    // Stop broadcasts an empty transcript; fall back to the cards.
    renderView();
    return;
  }
  titleEl.textContent = title || 'Untitled page';
  for (const [index, chunk] of chunks.entries()) {
    const div = document.createElement('div');
    div.className = 'line';
    div.textContent = chunk;
    div.addEventListener('click', () => jumpToLine(index));
    lyricsEl.append(div);
    lines.push(div);
  }
  renderView();
  if (
    lastStatus &&
    (lastStatus.state === 'speaking' || lastStatus.state === 'paused') &&
    lastStatus.chunkIndex !== undefined
  ) {
    setActiveLine(lastStatus.chunkIndex);
  }
}

/** Who owns the middle of the panel: the transcript, the cards, or both. */
function renderView(): void {
  const view = computeCtaView({
    playerState: lastStatus?.state ?? 'idle',
    hasLines: lines.length > 0,
    stopReason,
  });
  lyricsEl.hidden = lines.length === 0;
  ctaEl.hidden = view === 'hidden';
  ctaEl.classList.toggle('full', view === 'full');
  ctaEl.classList.toggle('compact', view === 'compact');

  // Nothing has been read, so the header must not keep advertising the last
  // article under "NOW READING".
  if (view === 'full') titleEl.textContent = 'MelonSpeak';

  // Replaying needs the text, which outlives the tab it was taken from.
  replayCard.hidden = view !== 'compact' || chunkStrings.length === 0;
  // Not the title — the header is showing that two lines above, and the page
  // card may well be showing it too. What distinguishes this card is that it
  // replays the transcript that is already here.
  const n = chunkStrings.length;
  replaySubEl.textContent = `From the top · ${n} ${n === 1 ? 'line' : 'lines'}`;

  syncSelectionWatch();
}

function setActiveLine(index: number): void {
  if (index === activeIndex || lines.length === 0) return;
  activeIndex = index;
  for (const [i, line] of lines.entries()) {
    const d = i - index;
    line.className =
      d === 0
        ? 'line active'
        : `line ${d < 0 ? 'past' : ''} ${Math.abs(d) <= 3 ? 'near' : ''}`.trim();
  }
  if (Date.now() > userScrollUntil) scrollActiveLineIntoView();
}

/** How long the user's own scrolling holds auto-scroll off — and, once they
 *  settle, how long before the view returns to the line being read. */
const FOLLOW_RESUME_MS = 6000;
/** A smooth scroll emits scroll events for a while after it is asked for.
 *  Ignore them, or the view mistakes its own movement for the user's. */
const PROGRAMMATIC_SCROLL_MS = 800;

let programmaticScrollUntil = 0;
let followTimer: ReturnType<typeof setTimeout> | undefined;

/** Centre the active line. Separate from setActiveLine because the view must
 *  also be able to come back to a line that has not changed — on a long chunk,
 *  or while paused, there is no next index to ride back on. */
function scrollActiveLineIntoView(): void {
  const line = lines[activeIndex];
  if (!line) return;
  programmaticScrollUntil = Date.now() + PROGRAMMATIC_SCROLL_MS;
  lyricsEl.scrollTo({
    top: line.offsetTop - lyricsEl.clientHeight / 2 + line.clientHeight / 2,
    behavior: 'smooth',
  });
}

// Any scroll of the transcript counts — wheel, touch, scrollbar drag, or the
// keyboard — so every one of them gets the same hands-off window and the same
// return to the line being read once the user settles.
lyricsEl.addEventListener(
  'scroll',
  () => {
    if (Date.now() < programmaticScrollUntil) return;
    userScrollUntil = Date.now() + FOLLOW_RESUME_MS;
    clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      if (shouldFollowActiveLine(lastStatus?.state ?? 'idle')) scrollActiveLineIntoView();
    }, FOLLOW_RESUME_MS);
  },
  { passive: true },
);

/** Click a line: jump an active read there, or restart a finished read
 *  from that line. */
function jumpToLine(index: number): void {
  const state = lastStatus?.state;
  if (state === 'speaking' || state === 'paused' || state === 'preparing') {
    sendPlayerCmd({ type: 'seek', index });
  } else if (chunkStrings.length > 0) {
    sendPlayerCmd({
      type: 'speak',
      text: chunkStrings.slice(index).join('\n\n'),
      title: titleEl.textContent || undefined,
    });
  }
  setActiveLine(index); // immediate feedback; status broadcasts confirm
}

// -- Call-to-action cards ---------------------------------------------------

/** Chrome grants <all_urls> at install; Firefox MV3 makes it opt-in, so the
 *  cards have to be able to say so and ask. */
let hasHostAccess = true;
let accessRefused = false;
/** False until we have actually looked at the active tab, so an unknown tab
 *  is never reported as an unreadable one. */
let tabResolved = false;
/** Last report from the watcher; kept so a speed change can re-render the
 *  duration without waiting for the user to re-highlight. */
let selection: SelectionMessage | null = null;
let speed = 1;

function renderPageCard(): void {
  if (!hasHostAccess) {
    pageCard.disabled = false;
    pageCard.classList.add('needs-access');
    pageCard.classList.remove('dormant');
    pageSubEl.textContent = accessRefused
      ? 'Enable access for all sites in about:addons → MelonSpeak → Permissions'
      : 'Give MelonSpeak access to page content';
    return;
  }
  pageCard.classList.remove('needs-access');
  if (!tabResolved) {
    // Still enabled: the background resolves the tab itself when we send no
    // id, so an early click is answered rather than swallowed.
    pageCard.disabled = false;
    pageCard.classList.remove('dormant');
    pageSubEl.textContent = '';
    return;
  }
  const readable = isReadableUrl(activeTabUrl);
  pageCard.disabled = !readable;
  pageCard.classList.toggle('dormant', !readable);
  pageSubEl.textContent = readable
    ? (activeTabTitle ?? activeTabUrl ?? '')
    : "This page can't be read";
}

function renderSelectionCard(): void {
  if (!hasHostAccess) {
    selectionCard.disabled = false;
    selectionCard.classList.add('needs-access');
    selectionCard.classList.remove('dormant');
    selectionSubEl.hidden = false;
    selectionSubEl.textContent = accessRefused
      ? 'Enable access for all sites to see what you highlight'
      : 'Give MelonSpeak access to see what you highlight';
    selectionQuoteEl.hidden = true;
    selectionMetaEl.hidden = true;
    return;
  }
  selectionCard.classList.remove('needs-access');
  const sel = selection;
  const lit = sel !== null && sel.words > 0;
  // Removing .dormant is what runs the wake animation, so this must only
  // change when the selection appears or goes away — not on every keystroke
  // of a growing one.
  selectionCard.disabled = !lit;
  selectionCard.classList.toggle('dormant', !lit);
  selectionSubEl.hidden = lit;
  selectionQuoteEl.hidden = !lit;
  selectionMetaEl.hidden = !lit;
  if (!lit) return;
  selectionQuoteEl.textContent = `“${sel.quote}”`;
  const words = `${sel.words} ${sel.words === 1 ? 'word' : 'words'}`;
  selectionMetaEl.textContent = `${words} · ${formatDuration(sel.words, speed)}`;
}

function setSelection(next: SelectionMessage | null): void {
  selection = next;
  renderSelectionCard();
}

// -- Watching the page's highlight ------------------------------------------
// Injected only while the cards are up, into the tab they refer to. The port
// is what lets the injected script know when to stop: see selection-watch.ts.

let selectionPort: chrome.runtime.Port | null = null;
let watchedTabId: number | null = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SELECTION_PORT) return;
  const tabId = port.sender?.tab?.id;
  // A watcher from a tab we have since moved away from, or one racing our own
  // teardown. Dropping the port makes it unhook itself.
  if (tabId === undefined || tabId !== watchedTabId) {
    port.disconnect();
    return;
  }
  selectionPort?.disconnect();
  selectionPort = port;
  port.onMessage.addListener((msg: SelectionMessage) => {
    if (selectionPort === port) setSelection(msg);
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (selectionPort === port) {
      selectionPort = null;
      setSelection(null);
    }
  });
});

function stopSelectionWatch(): void {
  // Disconnecting our own end does not fire our onDisconnect, so the reset is
  // manual here.
  selectionPort?.disconnect();
  selectionPort = null;
  watchedTabId = null;
  setSelection(null);
}

function syncSelectionWatch(): void {
  // Watch exactly while the cards are on screen, and only the tab they name.
  const target =
    !ctaEl.hidden && hasHostAccess && activeTabId !== null && isReadableUrl(activeTabUrl)
      ? activeTabId
      : null;
  if (target === watchedTabId) return;
  stopSelectionWatch();
  watchedTabId = target;
  if (target !== null) void armSelectionWatch(target);
}

async function armSelectionWatch(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/selection-watch.js'],
    });
  } catch {
    // Restricted page, or access revoked since we last looked. The card just
    // stays dormant.
  }
}

// -- Card actions -----------------------------------------------------------

function sendRead(type: 'read-page' | 'read-selection'): void {
  // Name the tab outright: this view knows its own window's active tab.
  const tabId = activeTabId ?? undefined;
  const msg: Message =
    type === 'read-page'
      ? { target: 'background', type: 'read-page', tabId }
      : { target: 'background', type: 'read-selection', tabId };
  void chrome.runtime.sendMessage(msg).catch(() => {});
}

async function requestHostAccess(): Promise<void> {
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
  } catch {
    // Firefox refuses the request from some contexts; point at the UI that
    // always works instead of leaving a card that does nothing.
    accessRefused = true;
  }
  if (granted) {
    hasHostAccess = true;
    accessRefused = false;
  }
  renderPageCard();
  renderSelectionCard();
  syncSelectionWatch();
}

pageCard.addEventListener('click', () => {
  if (!hasHostAccess) {
    void requestHostAccess();
    return;
  }
  sendRead('read-page');
});

selectionCard.addEventListener('click', () => {
  if (!hasHostAccess) {
    void requestHostAccess();
    return;
  }
  // Re-extracted from the page on arrival: the card shows a preview, never
  // the payload.
  sendRead('read-selection');
});

replayCard.addEventListener('click', () => {
  if (chunkStrings.length === 0) return;
  sendPlayerCmd({
    type: 'speak',
    text: chunkStrings.join('\n\n'),
    title: titleEl.textContent || undefined,
  });
});

async function initHostAccess(): Promise<void> {
  try {
    hasHostAccess = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  } catch {
    // No permissions API here; trust the manifest.
    hasHostAccess = true;
  }
  renderPageCard();
  renderSelectionCard();
  syncSelectionWatch();
}

// -- Status -----------------------------------------------------------------

function renderStatus(s: PlayerStatus): void {
  lastStatus = s;
  renderFooter();

  switch (s.state) {
    case 'speaking':
      eyebrowEl.textContent = 'NOW READING';
      if (s.chunkIndex !== undefined) setActiveLine(s.chunkIndex);
      break;
    case 'paused':
      eyebrowEl.textContent = 'PAUSED';
      break;
    // Not "nothing is being read" — something is on its way, so renderView
    // shows neither transcript nor cards.
    case 'preparing':
      eyebrowEl.textContent = (s.detail ?? 'PREPARING…').toUpperCase();
      break;
    case 'loading-model':
      eyebrowEl.textContent = (s.detail ?? 'LOADING VOICE…').toUpperCase();
      break;
    case 'error':
      eyebrowEl.textContent = `⚠ ${s.detail ?? 'ERROR'}`;
      target.fill(0);
      break;
    case 'idle':
      eyebrowEl.textContent = lines.length > 0 ? 'FINISHED' : 'READY';
      target.fill(0);
      for (const line of lines) line.className = 'line past';
      break;
  }
  renderView();
  // Last: the badge may need to override the eyebrow just set above.
  renderBadge();
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg?.target !== 'ui') return;
  if (msg.type === 'status') renderStatus(msg.status);
  if (msg.type === 'transcript') {
    setTranscript(msg.chunks, msg.title);
    connectPort(); // the player context just (re)appeared
  }
});

// -- Settings and installed models -----------------------------------------

/** Switching model mid-read re-speaks the remainder from the active line. The
 *  sheet delegates this here because the transcript lives in this module. */
async function chooseModel(id: ModelId): Promise<void> {
  await mutateSettings(() => ({ selectedModel: id }));
  const reading =
    lastStatus !== null && (lastStatus.state === 'speaking' || lastStatus.state === 'paused');
  if (reading && chunkStrings.length > 0) {
    // The background enriches the command with the just-saved model/voice.
    const from = Math.max(activeIndex, 0);
    sendPlayerCmd({
      type: 'speak',
      text: chunkStrings.slice(from).join('\n\n'),
      title: titleEl.textContent || undefined,
    });
  } else {
    sendPlayerCmd({ type: 'model-changed' }); // free the previous engine
  }
}

/** One place for everything a settings change touches, so the sheet, the
 *  footer and the highlight card's duration estimate can never disagree. */
function applyLoaded(s: Settings, installed: ModelId[]): void {
  installedIds = installed;
  speed = s.speed;
  settingsMenu.apply(s, installed);
  renderFooter();
  renderSelectionCard(); // the duration estimate depends on the speed
}

function applySettings(s: Settings): void {
  applyLoaded(s, MODEL_IDS.filter((id) => s.downloaded[id]));
}

/** The panel opens on every toolbar click, so this is where settings meet the
 *  filesystem: an evicted cache or a half-finished download would otherwise
 *  leave a model in the picker that cannot speak a word. The background is the
 *  only writer of settings, so a difference is reported, not fixed here. */
async function loadSettings(): Promise<void> {
  const [settings, installed] = await Promise.all([getSettings(), installedModels(MODEL_IDS)]);
  installedIds = MODEL_IDS.filter((id) => installed[id]);
  applyLoaded(settings, installedIds);
  if (MODEL_IDS.some((id) => Boolean(settings.downloaded[id]) !== installed[id])) {
    void chrome.runtime
      .sendMessage({ target: 'background', type: 'installed-state', installed } satisfies Message)
      .catch(() => {});
  }
}

onSettingsChanged(applySettings);

// -- Visualizer -------------------------------------------------------------

const BARS = 24;
const target = new Float64Array(BARS);
const shown = new Float64Array(BARS);

let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function connectPort(): void {
  if (port) return;
  try {
    const p = chrome.runtime.connect({ name: VIZ_PORT });
    port = p;
    p.onMessage.addListener((raw: VizMessage) => {
      if (raw.type === 'snapshot') {
        setTranscript(raw.chunks, raw.title);
        renderStatus(raw.status);
        if (raw.status.chunkIndex !== undefined) setActiveLine(raw.status.chunkIndex);
      } else if (raw.type === 'levels') {
        for (let i = 0; i < BARS; i++) target[i] = raw.levels[i] ?? 0;
        if (raw.levels.some((v) => v > 0.02)) lastAudioEnergyAt = performance.now();
      }
    });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // expected when no player context exists yet
      port = null;
      target.fill(0);
      // The player context may not exist yet; retry quietly.
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectPort, 2500);
    });
  } catch {
    reconnectTimer = setTimeout(connectPort, 2500);
  }
}

let lastAudioEnergyAt = 0;

/** True while the pipeline is working but no audio is audible: preparing,
 *  model loading, or a synthesis gap mid-read. */
function isProcessing(): boolean {
  const state = lastStatus?.state;
  if (state === 'preparing' || state === 'loading-model') return true;
  if (state === 'speaking') return performance.now() - lastAudioEnergyAt > 450;
  return false;
}

/** Whimsical stand-in levels: a bright bump ping-pongs across the bars with
 *  a gentle shimmer, so the visualizer reads as "thinking". */
function processingWave(): void {
  const t = performance.now() / 1000;
  const center = (Math.sin(t * 1.15) * 0.5 + 0.5) * (BARS - 1);
  for (let i = 0; i < BARS; i++) {
    const d = i - center;
    const bump = Math.exp((-d * d) / 5);
    target[i] = 0.08 + 0.5 * bump * (0.85 + 0.15 * Math.sin(t * 6 + i * 0.8));
  }
}

function draw(): void {
  if (isProcessing()) processingWave();
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const gap = 6;
  const bw = (w - gap * (BARS - 1)) / BARS;
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, '#2a8c4a');
  grad.addColorStop(0.55, '#e04a5c');
  grad.addColorStop(1, '#ff8b96');
  ctx.fillStyle = grad;

  for (let i = 0; i < BARS; i++) {
    // Fast attack, slow decay — feels like audio.
    shown[i] += (target[i] - shown[i]) * (target[i] > shown[i] ? 0.5 : 0.12);
    const bh = Math.max(3, shown[i] * (h - 4));
    const x = i * (bw + gap);
    const y = h - bh;
    const r = Math.min(bw / 2, 4);
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, r);
    ctx.fill();
  }
  requestAnimationFrame(draw);
}

renderView();
renderFooter();
renderSelectionCard();
connectPort();
sendPlayerCmd({ type: 'get-status' });
void loadSettings();
void initHostAccess();
void loadReadingTab();
void initTabTracking();
requestAnimationFrame(draw);

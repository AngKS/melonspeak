// The "Now Reading" view: live audio visualizer + Apple Music-style lyrics
// (auto-scrolling, current line highlighted, neighbors faded/blurred).
import { VIZ_PORT } from '../lib/messages';
import type { Message, ModelId, PlayerCommand, PlayerStatus, VizMessage } from '../lib/messages';
import type { ReadingTabState } from '../lib/reading-tab';
import { READING_TAB_KEY, computeBadge } from '../lib/reading-tab';
import {
  resolveReadTarget,
  resolveSpaceAction,
  shouldFollowActiveLine,
} from '../lib/reader-controls';
import type { Settings } from '../lib/settings';
import { getSettings, mutateSettings, onSettingsChanged } from '../lib/settings';
import { MODEL_IDS } from '../engines/registry';
import { installedModels } from '../engines/model-storage';
import { initReadActions } from './read-actions';
import { initSettingsMenu } from './settings-menu';

// The fallback surface pins its own size; see reader.css. Nothing else in the
// page branches on where it is rendered.
if (new URLSearchParams(location.search).get('surface') === 'popup') {
  document.documentElement.classList.add('as-popup');
}

const lyricsEl = document.getElementById('lyrics') as HTMLElement;
const emptyEl = document.getElementById('empty') as HTMLElement;
const titleEl = document.getElementById('title') as HTMLElement;
const eyebrowEl = document.getElementById('eyebrow') as HTMLElement;
const headEl = document.getElementById('head') as HTMLElement;
const badgeEl = document.getElementById('bg-badge') as HTMLElement;
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
let myWindowId: number | null = null;
/** Set when the background ended the read because the tab closed. */
let stopReason: 'tab-closed' | null = null;

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
  const state = computeBadge({
    readingTabId,
    activeTabId,
    playerState: lastStatus?.state ?? 'idle',
    stopReason,
  });
  badgeEl.hidden = state === 'none';
  if (state === 'background') {
    badgeEl.textContent = '⤴ BACKGROUND';
    badgeEl.className = 'badge backgrounded';
  } else if (state === 'stopped-tab-closed') {
    badgeEl.textContent = '⊘ PAGE CLOSED';
    badgeEl.className = 'badge closed';
    // Overrides the 'FINISHED' renderStatus leaves on an idle player — the
    // read didn't finish, the page went away.
    eyebrowEl.textContent = 'STOPPED';
  }
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

chrome.tabs.onActivated.addListener((info) => {
  if (myWindowId !== null && info.windowId !== myWindowId) return;
  activeTabId = info.tabId;
  renderBadge();
});

function applyReadingTab(state: ReadingTabState | undefined): void {
  readingTabId = state?.tabId ?? null;
  // Set before the player's empty-transcript broadcast can land — that
  // ordering is what lets setTranscript() know to keep the lyrics.
  stopReason = state?.reason === 'tab-closed' ? 'tab-closed' : null;
  lyricsEl.classList.toggle('stopped', stopReason === 'tab-closed');
  renderBadge();
}

// storage.session is the source of truth, so a sidebar opened mid-read gets
// the current value and every later change without depending on the
// background worker being alive to tell it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[READING_TAB_KEY]) return;
  applyReadingTab(changes[READING_TAB_KEY].newValue as ReadingTabState | undefined);
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
    activeTabId = tab?.id ?? null;
  } catch {
    // No window context; the badge stays hidden rather than guessing.
  }
  renderBadge();
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
    // Stop broadcasts an empty transcript; fall back to the empty state.
    showLyrics(false);
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
  showLyrics(true);
  if (
    lastStatus &&
    (lastStatus.state === 'speaking' || lastStatus.state === 'paused') &&
    lastStatus.chunkIndex !== undefined
  ) {
    setActiveLine(lastStatus.chunkIndex);
  }
}

function showLyrics(show: boolean): void {
  lyricsEl.hidden = !show;
  emptyEl.style.display = show ? 'none' : '';
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
    case 'preparing':
      eyebrowEl.textContent = (s.detail ?? 'PREPARING…').toUpperCase();
      if (lines.length === 0) {
        // Not "nothing is being read" — something is on its way.
        lyricsEl.hidden = true;
        emptyEl.style.display = 'none';
      }
      break;
    case 'loading-model':
      eyebrowEl.textContent = (s.detail ?? 'LOADING VOICE…').toUpperCase();
      break;
    case 'error':
      eyebrowEl.textContent = `⚠ ${s.detail ?? 'ERROR'}`;
      target.fill(0);
      break;
    case 'idle':
      eyebrowEl.textContent = lines.length > 0 ? 'FINISHED' : 'NOW READING';
      target.fill(0);
      if (lines.length > 0) {
        for (const line of lines) line.className = 'line past';
      } else {
        showLyrics(false);
      }
      break;
  }
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

function applySettings(s: Settings): void {
  installedIds = MODEL_IDS.filter((id) => s.downloaded[id]);
  settingsMenu.apply(s, installedIds);
  renderFooter();
}

/** The panel opens on every toolbar click, so this is where settings meet the
 *  filesystem: an evicted cache or a half-finished download would otherwise
 *  leave a model in the picker that cannot speak a word. The background is the
 *  only writer of settings, so a difference is reported, not fixed here. */
async function loadSettings(): Promise<void> {
  const [settings, installed] = await Promise.all([getSettings(), installedModels(MODEL_IDS)]);
  installedIds = MODEL_IDS.filter((id) => installed[id]);
  settingsMenu.apply(settings, installedIds);
  renderFooter();
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

showLyrics(false);
renderFooter();
connectPort();
sendPlayerCmd({ type: 'get-status' });
void loadSettings();
void loadReadingTab();
void initTabTracking();
requestAnimationFrame(draw);

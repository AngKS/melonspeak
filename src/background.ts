// MV3 service worker (Chrome) / event-page script (Firefox).
// Owns: install hook, context menu, extraction, and routing to the player.
import type { ExtractResult } from './content/extract';
import type { Message, ModelId, PlayerCommand, PlayerStatus } from './lib/messages';
import { broadcast } from './lib/messages';
import type { ReadingTabState } from './lib/reading-tab';
import { READING_TAB_KEY } from './lib/reading-tab';
import { getSettings, mutateSettings } from './lib/settings';
import { hasSidebarAction, openSidebar, toggleSidebar } from './lib/sidebar';
import { resolveActionSurface } from './lib/action-surface';

const IS_CHROME_OFFSCREEN = typeof chrome.offscreen !== 'undefined';
const MENU_ID = 'melonspeak-speak';
/** Reading beyond this is ~3h of audio; avoids accidental monster jobs. */
const MAX_CHARS = 120_000;

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({ id: MENU_ID, title: 'Speak content', contexts: ['selection'] }, () => {
    // Ignore "already exists" from event-page re-runs.
    void chrome.runtime.lastError;
  });
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
  }
});

// The toolbar button opens the reading panel, which now holds every setting
// and control. Run at every worker/event-page start rather than only on
// install: an MV3 worker is torn down and restarted constantly, and this is
// idempotent.
function applyActionSurface(): void {
  const surface = resolveActionSurface({
    hasSidePanel: typeof chrome.sidePanel?.setPanelBehavior === 'function',
    hasSidebarAction: hasSidebarAction(),
  });
  if (surface === 'side-panel') {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } else if (surface === 'popup') {
    // No sidebar of any kind: serve the reading view as the action popup so no
    // control becomes unreachable. The parameter makes it size itself.
    void chrome.action?.setPopup({ popup: 'reader/reader.html?surface=popup' });
  }
  // 'sidebar' (Firefox) is handled by the onClicked listener below; Chrome
  // never fires it once setPanelBehavior is on.
}
applyActionSurface();

chrome.action?.onClicked?.addListener(() => toggleSidebar());

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined) return;
  // contextMenus.onClicked is a direct user-action handler — the only place
  // the background may open the sidebar (UI pages open it from their own
  // click handlers; runtime.onMessage cannot, crbug.com/355266358). No await
  // may precede this call or the gesture is spent.
  openSidebar(tab.id);
  void readTab(tab.id, 'selection', info.selectionText);
});

// Stop reading when the tab being read is closed. The tab id lives in
// chrome.storage.session (not a background variable) because Chrome can
// evict the MV3 service worker mid-read and this listener must still
// recognise the tab afterwards.
/** Written only here; the reading view observes storage.session.onChanged
 *  rather than a broadcast. Broadcasting from this worker is unreliable for
 *  state the view must not miss: an MV3 worker can be torn down the moment a
 *  listener returns, dropping any send queued after an await. Storage has no
 *  such lifetime coupling. */
async function setReadingTab(tabId: number | null, reason?: 'tab-closed'): Promise<void> {
  const state: ReadingTabState = reason ? { tabId, reason } : { tabId };
  try {
    await chrome.storage.session.set({ [READING_TAB_KEY]: state });
  } catch {
    // No session storage: the badge simply never appears.
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.get(READING_TAB_KEY).then(async (stored) => {
    const state = stored[READING_TAB_KEY] as ReadingTabState | undefined;
    if (state?.tabId !== tabId) return;
    // Record the reason BEFORE stopping: stopAll() broadcasts an empty
    // transcript, and the reading view must already know why or it wipes the
    // lyrics with nothing left to explain the silence.
    await setReadingTab(null, 'tab-closed');
    await deliverToPlayer({ type: 'stop' });
  });
});

// The player context can't touch chrome.storage or chrome.action, so its
// broadcasts are also handled here: settings persistence and the error badge.
// Reached via onMessage on Chrome (offscreen → service worker) and via the
// __melonBroadcastLocal sink on Firefox, where the player shares this page
// and runtime.sendMessage would never loop back to it.
function handleUiMessage(msg: Message): void {
  if (msg.target !== 'ui') return;
  if (msg.type === 'download-progress') {
    const { modelId, done, error } = msg.progress;
    if (done && !error) {
      void mutateSettings((s) => ({
        downloaded: { ...s.downloaded, [modelId]: true },
        selectedModel: s.selectedModel ?? modelId,
        onboarded: true,
      }));
    }
  } else if (msg.type === 'model-missing') {
    void mutateSettings((s) => {
      const downloaded = { ...s.downloaded, [msg.modelId]: false };
      const remaining = (Object.keys(downloaded) as ModelId[]).filter((m) => downloaded[m]);
      return {
        downloaded,
        selectedModel: s.selectedModel === msg.modelId ? (remaining[0] ?? null) : s.selectedModel,
      };
    });
  } else if (msg.type === 'status') {
    // Errors must be visible even with every UI surface closed.
    const isError = msg.status.state === 'error';
    void chrome.action?.setBadgeText({ text: isError ? '!' : '' });
    void chrome.action?.setTitle({
      title: isError ? `MelonSpeak — ${msg.status.detail ?? 'error'}` : 'MelonSpeak',
    });
  }
}

// Flipping the acceleration beta must rebuild the engine: the player caches
// engines per (model, accel mode), and a live read keeps speaking with the
// old engine forever otherwise. model-changed stops the read and frees it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes['settings']) return;
  const oldAccel = (changes['settings'].oldValue as { accelBeta?: boolean } | undefined)?.accelBeta;
  const newAccel = (changes['settings'].newValue as { accelBeta?: boolean } | undefined)?.accelBeta;
  if ((oldAccel ?? false) !== (newAccel ?? false)) {
    void deliverToPlayer({ type: 'model-changed' });
  }
});

void chrome.action?.setBadgeBackgroundColor?.({ color: '#e04a5c' });
(globalThis as { __melonBroadcastLocal?: (m: Message) => void }).__melonBroadcastLocal =
  handleUiMessage;

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (!msg) return;
  if (msg.target === 'ui') {
    handleUiMessage(msg);
    return;
  }
  if (msg.target !== 'background') return;
  if (msg.type === 'player-cmd') {
    // A user-initiated stop ends the association with the tab being read.
    if (msg.cmd.type === 'stop') void setReadingTab(null);
    void deliverToPlayer(msg.cmd);
  } else if (msg.type === 'read-page' || msg.type === 'read-selection') {
    const mode = msg.type === 'read-page' ? 'page' : 'selection';
    // The reading view names the tab outright: it lives in a browser window
    // and knows that window's active tab, which lastFocusedWindow cannot be
    // relied on to reproduce.
    if (msg.tabId !== undefined) void readTab(msg.tabId, mode);
    else void readActiveTab(mode);
  } else if (msg.type === 'installed-state') {
    void reconcileInstalled(msg.installed);
  } else if (msg.type === 'clear-reading-tab') {
    void setReadingTab(null);
  }
});

/** Settings only *record* what was downloaded; UI pages can see the files
 *  themselves and report the truth here, since this is the only writer. */
async function reconcileInstalled(installed: Partial<Record<ModelId, boolean>>): Promise<void> {
  await mutateSettings((s) => {
    const downloaded = { ...s.downloaded, ...installed };
    const remaining = (Object.keys(downloaded) as ModelId[]).filter((m) => downloaded[m]);
    const keepSelected = s.selectedModel !== null && downloaded[s.selectedModel];
    return {
      downloaded,
      selectedModel: keepSelected ? s.selectedModel : (remaining[0] ?? null),
    };
  });
}

async function readActiveTab(mode: 'page' | 'selection'): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) {
    errorStatus('No active tab to read.');
    return;
  }
  await readTab(tab.id, mode);
}

async function readTab(tabId: number, mode: 'page' | 'selection', fallbackText?: string): Promise<void> {
  // Immediate feedback: extraction plus first synthesis can take seconds.
  broadcast({
    target: 'ui',
    type: 'status',
    status: { state: 'preparing', modelId: null, detail: 'Reading page…' },
  });
  // Warm the player while extraction runs: offscreen-document creation and
  // the model load dominate the wait before the first word, and neither
  // needs the text. The player dedupes this against the 'speak' that follows.
  void deliverToPlayer({ type: 'prepare' });
  let result: ExtractResult | undefined;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/extract.js'] });
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: (m: 'page' | 'selection') => globalThis.__melonExtract?.(m),
      args: [mode],
    });
    result = injected[0]?.result ?? undefined;
  } catch {
    // Restricted page (chrome://, addons store, PDF viewer, …)
  }
  if (!result?.ok && fallbackText?.trim()) {
    result = { ok: true, text: fallbackText, title: 'Selection' };
  }
  if (!result) {
    errorStatus('This page cannot be read (browser-restricted page).');
    return;
  }
  if (!result.ok) {
    errorStatus(result.error ?? 'Nothing to read.');
    return;
  }
  let text = result.text;
  let title = result.title;
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    title += ' (first part)';
  }
  // Only a successful extraction claims the tab: a failed read leaves an
  // already-playing read's badge alone.
  await setReadingTab(tabId);
  await deliverToPlayer({ type: 'speak', text, title });
}

function errorStatus(detail: string): void {
  const status: PlayerStatus = { state: 'error', modelId: null, detail };
  broadcast({ target: 'ui', type: 'status', status });
}

// ---------------------------------------------------------------------------
// Player delivery.
// Chrome: the player lives in an offscreen document (created on demand).
// Firefox: the player module runs in this same background page.
// ---------------------------------------------------------------------------

/** Commands that justify spinning up the player context. */
const CREATION_WORTHY = new Set<PlayerCommand['type']>(['speak', 'prepare', 'download']);

async function deliverToPlayer(cmd: PlayerCommand): Promise<void> {
  if (cmd.type === 'speak') {
    // Resolve settings here — the player context has no chrome.storage.
    const s = await getSettings();
    const modelId = cmd.modelId ?? s.selectedModel ?? undefined;
    if (!modelId) {
      errorStatus('No voice model installed yet — open MelonSpeak setup first.');
      return;
    }
    cmd = {
      ...cmd,
      modelId,
      voice: cmd.voice ?? s.voices[modelId],
      speed: s.speed,
      accel: s.accelBeta,
    };
  } else if (cmd.type === 'prepare') {
    const s = await getSettings();
    if (!s.selectedModel) return; // the 'speak' that follows surfaces the error
    cmd = { ...cmd, modelId: s.selectedModel, accel: s.accelBeta };
  }
  if (!IS_CHROME_OFFSCREEN) {
    deliverLocal(cmd);
    return;
  }
  if (!(await hasOffscreen())) {
    if (!CREATION_WORTHY.has(cmd.type)) {
      if (cmd.type === 'get-status') {
        broadcast({ target: 'ui', type: 'status', status: { state: 'idle', modelId: null } });
      }
      return;
    }
    await createOffscreen();
  }
  // The player ACKs with `true`; retry until its module has loaded. Short
  // interval: this wait sits directly on the click-to-first-word path.
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const ack = await chrome.runtime.sendMessage({ target: 'player', cmd } satisfies Message);
      if (ack === true) return;
    } catch {
      // No listeners at all yet.
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  errorStatus('The audio player did not respond. Try reloading the extension.');
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  return contexts.length > 0;
}

async function createOffscreen(): Promise<void> {
  try {
    await chrome.offscreen.createDocument({
      url: 'player/offscreen.html',
      reasons: ['AUDIO_PLAYBACK' as chrome.offscreen.Reason, 'BLOBS' as chrome.offscreen.Reason],
      justification: 'Runs the local text-to-speech model and plays the synthesized audio.',
    });
  } catch (err) {
    // Racing a concurrent creation is fine; anything else is not.
    if (!String(err).includes('single offscreen')) throw err;
  }
}

function deliverLocal(cmd: PlayerCommand, tries = 0): void {
  const deliver = (globalThis as { __melonSpeakPlayerDeliver?: (c: PlayerCommand) => void })
    .__melonSpeakPlayerDeliver;
  if (deliver) {
    deliver(cmd);
  } else if (tries < 100) {
    // Player module in this page is still loading.
    setTimeout(() => deliverLocal(cmd, tries + 1), 50);
  }
}

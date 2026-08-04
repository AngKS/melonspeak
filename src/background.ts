// MV3 service worker (Chrome) / event-page script (Firefox).
// Owns: install hook, context menu, extraction, and routing to the player.
import type { ExtractResult } from './content/extract';
import type { Message, ModelId, PlayerCommand, PlayerStatus } from './lib/messages';
import { broadcast } from './lib/messages';
import { getSettings, mutateSettings } from './lib/settings';

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

// Chrome ≥116: surface the Now Reading view in the side panel whenever a
// read starts. sidePanel.open() only works while the triggering user gesture
// is still live, so it runs at command receipt — before extraction. On
// browsers without chrome.sidePanel (Firefox) the popup stays the reading
// surface and this is a no-op.
function openReadingPanel(tabId: number | undefined): void {
  if (tabId === undefined || typeof chrome.sidePanel?.open !== 'function') return;
  try {
    void chrome.sidePanel.open({ tabId }).catch(() => {});
  } catch {
    // Gesture expired or panel unavailable; reading works without it.
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined) return;
  openReadingPanel(tab.id);
  void readTab(tab.id, 'selection', info.selectionText);
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
    if (msg.cmd.type === 'speak') {
      // e.g. onboarding's "Hear a sample": show the reading view for it too.
      void chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then(([tab]) => openReadingPanel(tab?.id));
    }
    void deliverToPlayer(msg.cmd);
  } else if (msg.type === 'read-page' || msg.type === 'read-selection') {
    void readActiveTab(msg.type === 'read-page' ? 'page' : 'selection');
  }
});

async function readActiveTab(mode: 'page' | 'selection'): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) {
    errorStatus('No active tab to read.');
    return;
  }
  openReadingPanel(tab.id);
  await readTab(tab.id, mode);
}

async function readTab(tabId: number, mode: 'page' | 'selection', fallbackText?: string): Promise<void> {
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
const CREATION_WORTHY = new Set<PlayerCommand['type']>(['speak', 'download']);

async function deliverToPlayer(cmd: PlayerCommand): Promise<void> {
  if (cmd.type === 'speak') {
    // Resolve settings here — the player context has no chrome.storage.
    const s = await getSettings();
    const modelId = cmd.modelId ?? s.selectedModel ?? undefined;
    if (!modelId) {
      errorStatus('No voice model installed yet — open MelonSpeak setup first.');
      return;
    }
    cmd = { ...cmd, modelId, voice: cmd.voice ?? s.voices[modelId], speed: s.speed };
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
  // The player ACKs with `true`; retry until its module has loaded.
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const ack = await chrome.runtime.sendMessage({ target: 'player', cmd } satisfies Message);
      if (ack === true) return;
    } catch {
      // No listeners at all yet.
    }
    await new Promise((r) => setTimeout(r, 200));
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

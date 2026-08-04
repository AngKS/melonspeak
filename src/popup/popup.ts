import type { Message, ModelId, PlayerCommand, PlayerStatus } from '../lib/messages';
import { getSettings, mutateSettings, updateSettings } from '../lib/settings';
import { MODELS, MODEL_IDS } from '../engines/registry';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const modelSelect = $<HTMLSelectElement>('model');
const voiceSelect = $<HTMLSelectElement>('voice');
const voiceRow = $<HTMLDivElement>('voice-row');
const speedInput = $<HTMLInputElement>('speed');
const speedLabel = $<HTMLSpanElement>('speed-label');
const statusEl = $<HTMLParagraphElement>('status');
const active = $<HTMLDivElement>('active');

function sendPlayerCmd(cmd: PlayerCommand): void {
  void chrome.runtime
    .sendMessage({ target: 'background', type: 'player-cmd', cmd } satisfies Message)
    .catch(() => {});
}

function openOnboarding(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
  window.close();
}

async function init(): Promise<void> {
  const settings = await getSettings();
  const downloaded = MODEL_IDS.filter((id) => settings.downloaded[id]);

  if (downloaded.length === 0) {
    $('setup').hidden = false;
    modelSelect.hidden = true;
    $('open-setup').addEventListener('click', openOnboarding);
  } else {
    $('main').hidden = false;
    const current = settings.selectedModel && downloaded.includes(settings.selectedModel)
      ? settings.selectedModel
      : downloaded[0];
    // The picker and settings must agree, or "Read page" resolves a model
    // the popup never showed (or none at all).
    if (settings.selectedModel !== current) void updateSettings({ selectedModel: current });
    for (const id of downloaded) {
      const opt = new Option(MODELS[id].shortName, id, false, id === current);
      modelSelect.add(opt);
    }
    renderVoices(current, settings.voices[current]);

    modelSelect.addEventListener('change', async () => {
      const id = modelSelect.value as ModelId;
      const s = await updateSettings({ selectedModel: id });
      sendPlayerCmd({ type: 'model-changed' });
      renderVoices(id, s.voices[id]);
    });
    voiceSelect.addEventListener('change', async () => {
      const modelId = modelSelect.value as ModelId;
      const voice = voiceSelect.value;
      await mutateSettings((s) => ({ voices: { ...s.voices, [modelId]: voice } }));
      // set-voice retargets an in-progress read; model-changed would kill it.
      sendPlayerCmd({ type: 'set-voice', modelId, voice });
    });

    speedInput.value = String(settings.speed);
    speedLabel.textContent = `${settings.speed.toFixed(1)}×`;
    speedInput.addEventListener('input', () => {
      speedLabel.textContent = `${Number(speedInput.value).toFixed(1)}×`;
    });
    speedInput.addEventListener('change', () => {
      const speed = Number(speedInput.value);
      void updateSettings({ speed });
      sendPlayerCmd({ type: 'set-speed', speed });
    });

    $('read-page').addEventListener('click', () => {
      void chrome.runtime
        .sendMessage({ target: 'background', type: 'read-page' } satisfies Message)
        .catch(() => {});
    });
    $('read-selection').addEventListener('click', () => {
      void chrome.runtime
        .sendMessage({ target: 'background', type: 'read-selection' } satisfies Message)
        .catch(() => {});
    });
    $('pause').addEventListener('click', () => sendPlayerCmd({ type: 'pause' }));
    $('resume').addEventListener('click', () => sendPlayerCmd({ type: 'resume' }));
    $('stop').addEventListener('click', () => sendPlayerCmd({ type: 'stop' }));
    $('open-reader').addEventListener('click', async () => {
      // Prefer the side panel (Chrome ≥116); it must open while this click's
      // gesture is live. Firefox has no sidePanel — fall back to a tab.
      if (typeof chrome.sidePanel?.open === 'function') {
        try {
          const win = await chrome.windows.getCurrent();
          if (win.id !== undefined) {
            await chrome.sidePanel.open({ windowId: win.id });
            window.close();
            return;
          }
        } catch {
          // fall through to the tab fallback
        }
      }
      void chrome.tabs.create({ url: chrome.runtime.getURL('reader/reader.html') });
      window.close();
    });

    sendPlayerCmd({ type: 'get-status' });
  }
  $('manage').addEventListener('click', (e) => {
    e.preventDefault();
    openOnboarding();
  });
}

function renderVoices(id: ModelId, selected?: string): void {
  const voices = MODELS[id].voices;
  voiceRow.hidden = !voices || voices.length < 2;
  if (!voices) return;
  voiceSelect.replaceChildren();
  const current = selected ?? MODELS[id].defaultVoice;
  for (const v of voices) {
    voiceSelect.add(new Option(v.label, v.id, false, v.id === current));
  }
}

function renderStatus(s: PlayerStatus): void {
  const speaking = s.state === 'speaking' || s.state === 'paused';
  active.hidden = !speaking;
  $('pause').hidden = s.state !== 'speaking';
  $('resume').hidden = s.state !== 'paused';

  if (speaking) {
    $('now-reading').textContent =
      (s.state === 'paused' ? '⏸ ' : '') + (s.title || 'Reading…');
    const frac =
      s.chunkCount && s.chunkCount > 0 ? ((s.chunkIndex ?? 0) + 1) / s.chunkCount : 0;
    $('bar-fill').style.width = `${Math.round(frac * 100)}%`;
  }

  statusEl.classList.toggle('error', s.state === 'error');
  if (s.state === 'error') {
    statusEl.hidden = false;
    statusEl.textContent = s.detail ?? 'Something went wrong.';
  } else if (s.state === 'loading-model') {
    statusEl.hidden = false;
    statusEl.textContent = s.detail ?? 'Loading voice model…';
  } else {
    statusEl.hidden = true;
  }
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg?.target === 'ui' && msg.type === 'status') renderStatus(msg.status);
});

void init();

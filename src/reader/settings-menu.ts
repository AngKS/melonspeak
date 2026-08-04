// The ☰ sheet: everything the action popup used to own except downloading —
// voice model, voice, speed, and the way out to the model manager.
import type { ModelId, PlayerCommand } from '../lib/messages';
import type { Settings } from '../lib/settings';
import { mutateSettings, updateSettings } from '../lib/settings';
import { MODELS } from '../engines/registry';

export interface SettingsMenuDeps {
  sendPlayerCmd(cmd: PlayerCommand): void;
  openOnboarding(): void;
  /** The panel owns the transcript, so it decides whether a model switch
   *  re-speaks the remainder or just frees the previous engine. */
  onModelChosen(id: ModelId): void;
}

export interface SettingsMenu {
  /** Re-render from settings. `installed` is the list the panel has verified
   *  against disk — settings alone can claim a model an evicted cache no
   *  longer holds. */
  apply(settings: Settings, installed: ModelId[]): void;
  close(): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function initSettingsMenu(deps: SettingsMenuDeps): SettingsMenu {
  const btn = $<HTMLButtonElement>('menu-btn');
  const sheet = $('sheet');
  const scrim = $('scrim');
  const modelList = $('model-list');
  const voiceRow = $('voice-row');
  const voiceSelect = $<HTMLSelectElement>('voice');
  const speedInput = $<HTMLInputElement>('speed');
  const speedLabel = $('speed-label');
  const metaEl = $('meta-settings');

  let selected: ModelId | null = null;
  let installedIds: ModelId[] = [];

  let isOpen = false;
  function setOpen(open: boolean): void {
    isOpen = open;
    sheet.hidden = !open;
    scrim.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }
  const close = () => setOpen(false);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!isOpen);
  });
  scrim.addEventListener('click', close);
  // Esc closes the sheet before anything else can act on the key.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      e.stopPropagation();
      close();
    }
  });

  $('manage').addEventListener('click', () => {
    close();
    deps.openOnboarding();
  });

  voiceSelect.addEventListener('change', async () => {
    if (!selected) return;
    const modelId = selected;
    const voice = voiceSelect.value;
    const s = await mutateSettings((prev) => ({ voices: { ...prev.voices, [modelId]: voice } }));
    // set-voice retargets an in-progress read; model-changed would kill it.
    deps.sendPlayerCmd({ type: 'set-voice', modelId, voice });
    renderMeta(s);
  });

  speedInput.addEventListener('input', () => {
    speedLabel.textContent = `${Number(speedInput.value).toFixed(1)}×`;
  });
  speedInput.addEventListener('change', async () => {
    const speed = Number(speedInput.value);
    const s = await updateSettings({ speed });
    deps.sendPlayerCmd({ type: 'set-speed', speed });
    renderMeta(s);
  });

  function renderModelList(): void {
    modelList.replaceChildren();
    for (const id of installedIds) {
      const item = document.createElement('button');
      item.className = 'model-item';
      item.dataset['model'] = id;
      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = id === selected ? '✓' : '';
      const names = document.createElement('span');
      names.className = 'names';
      const short = document.createElement('div');
      short.className = 'short';
      short.textContent = MODELS[id].shortName;
      const real = document.createElement('div');
      real.className = 'real';
      real.textContent = MODELS[id].displayName;
      names.append(short, real);
      item.append(check, names);
      item.addEventListener('click', () => {
        close();
        if (id !== selected) deps.onModelChosen(id);
      });
      modelList.append(item);
    }
    if (installedIds.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'foot-note';
      empty.textContent = 'No voice models installed yet.';
      modelList.append(empty);
    }
  }

  function renderVoices(voices: Settings['voices']): void {
    const list = selected ? MODELS[selected].voices : undefined;
    voiceRow.hidden = !selected || !list || list.length < 2;
    if (!selected || !list) return;
    const current = voices[selected] ?? MODELS[selected].defaultVoice;
    voiceSelect.replaceChildren();
    for (const v of list) {
      voiceSelect.add(new Option(v.label, v.id, false, v.id === current));
    }
  }

  function renderMeta(s: Settings): void {
    if (!selected) {
      metaEl.textContent = 'No voice model';
      return;
    }
    const model = MODELS[selected];
    const parts = [model.shortName];
    const list = model.voices;
    if (list && list.length >= 2) {
      const id = s.voices[selected] ?? model.defaultVoice;
      const label = list.find((v) => v.id === id)?.label;
      if (label) parts.push(label);
    }
    parts.push(`${s.speed.toFixed(1)}×`);
    // Bullets, not middots: voice labels contain middots ("Heart · US female")
    // and the line would read as one flat list of four things.
    metaEl.textContent = parts.join(' • ');
  }

  return {
    close,
    apply(settings, installed) {
      installedIds = installed;
      selected =
        settings.selectedModel && installed.includes(settings.selectedModel)
          ? settings.selectedModel
          : (installed[0] ?? null);
      renderModelList();
      renderVoices(settings.voices);
      // Not while dragging: rewriting the value mid-gesture fights the user.
      if (document.activeElement !== speedInput) {
        speedInput.value = String(settings.speed);
        speedLabel.textContent = `${settings.speed.toFixed(1)}×`;
      }
      renderMeta(settings);
    },
  };
}

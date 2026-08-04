import type { Message, ModelId, PlayerCommand } from '../lib/messages';
import { getSettings, mutateSettings } from '../lib/settings';
import { openSidebar, primeSidebar } from '../lib/sidebar';

primeSidebar();
import { MODELS, MODEL_IDS, loadEngineModule } from '../engines/registry';

const SAMPLE_TEXT =
  "Hi! I'm MelonSpeak. I read any web page out loud, entirely on your device.";

const cardsEl = document.getElementById('cards') as HTMLDivElement;
const downloadBtn = document.getElementById('download') as HTMLButtonElement;
const downloadNote = document.getElementById('download-note') as HTMLParagraphElement;
const doneSection = document.getElementById('done') as HTMLElement;

function sendPlayerCmd(cmd: PlayerCommand): void {
  void chrome.runtime
    .sendMessage({ target: 'background', type: 'player-cmd', cmd } satisfies Message)
    .catch(() => {});
}

const fmtMB = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

interface CardEls {
  checkbox: HTMLInputElement;
  progress: HTMLDivElement;
  fill: HTMLDivElement;
  pct: HTMLSpanElement;
  installed: HTMLDivElement;
  error: HTMLDivElement;
}
const cards = new Map<ModelId, CardEls>();

function buildCard(id: ModelId): HTMLElement {
  const meta = MODELS[id];
  const card = document.createElement('label');
  card.className = 'card';
  card.innerHTML = `
    <input type="checkbox" ${meta.recommended ? 'checked' : ''} />
    <div class="body">
      <div class="title">${meta.shortName}
        ${meta.recommended ? '<span class="badge">Recommended</span>' : ''}
      </div>
      <div class="real">${meta.displayName} · ~${fmtMB(meta.sizeBytes)} download</div>
      <p class="desc">${meta.description}</p>
      <div class="progress" hidden>
        <div class="bar"><div class="fill"></div></div>
        <span class="pct">0%</span>
      </div>
      <div class="installed" hidden>
        <span>✓ Installed</span>
        <button type="button" class="try">▶ Hear a sample</button>
        <button type="button" class="remove">Remove</button>
      </div>
      <div class="dl-error" hidden></div>
    </div>`;

  const els: CardEls = {
    checkbox: card.querySelector('input')!,
    progress: card.querySelector('.progress')!,
    fill: card.querySelector('.fill')!,
    pct: card.querySelector('.pct')!,
    installed: card.querySelector('.installed')!,
    error: card.querySelector('.dl-error')!,
  };
  cards.set(id, els);

  card.querySelector<HTMLButtonElement>('.try')!.addEventListener('click', (e) => {
    e.preventDefault();
    openSidebar(); // synchronously, while this click's gesture is live
    sendPlayerCmd({ type: 'speak', text: SAMPLE_TEXT, title: 'Sample', modelId: id });
  });
  card.querySelector<HTMLButtonElement>('.remove')!.addEventListener('click', (e) => {
    e.preventDefault();
    void removeModel(id);
  });
  return card;
}

function markInstalled(id: ModelId, installed: boolean): void {
  const els = cards.get(id)!;
  els.installed.hidden = !installed;
  els.checkbox.disabled = installed;
  els.checkbox.checked = installed ? false : els.checkbox.checked;
  els.progress.hidden = true;
  if (installed) {
    els.error.hidden = true;
    doneSection.hidden = false;
  }
  updateDownloadButton();
}

function updateDownloadButton(): void {
  const selected = MODEL_IDS.filter(
    (id) => cards.get(id)!.checkbox.checked && !cards.get(id)!.checkbox.disabled,
  );
  const total = selected.reduce((sum, id) => sum + MODELS[id].sizeBytes, 0);
  downloadBtn.disabled = selected.length === 0;
  downloadBtn.textContent =
    selected.length === 0
      ? 'Download selected'
      : `Download ${selected.length} model${selected.length > 1 ? 's' : ''} (~${fmtMB(total)})`;
}

async function removeModel(id: ModelId): Promise<void> {
  const mod = await loadEngineModule(id);
  await mod.remove();
  await mutateSettings((s) => {
    const downloaded = { ...s.downloaded, [id]: false };
    const remaining = MODEL_IDS.filter((m) => downloaded[m]);
    return {
      downloaded,
      selectedModel: s.selectedModel === id ? (remaining[0] ?? null) : s.selectedModel,
    };
  });
  sendPlayerCmd({ type: 'model-changed' });
  markInstalled(id, false);
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg?.target !== 'ui' || msg.type !== 'download-progress') return;
  const { modelId, loaded, total, done, error, file } = msg.progress;
  const els = cards.get(modelId);
  if (!els) return;
  if (error) {
    els.progress.hidden = true;
    els.error.hidden = false;
    els.error.textContent = `Download failed: ${error} — select and try again.`;
    els.checkbox.disabled = false;
    updateDownloadButton();
    return;
  }
  if (done) {
    // The background persists downloaded/onboarded flags on this same event.
    markInstalled(modelId, true);
    return;
  }
  // A download resumed from a previous visit: reflect that it's running.
  els.progress.hidden = false;
  els.error.hidden = true;
  els.checkbox.disabled = true;
  const pct = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
  els.fill.style.width = `${pct}%`;
  els.pct.textContent = `${fmtMB(loaded)} / ${fmtMB(total)}${file ? '' : ''}`;
});

downloadBtn.addEventListener('click', () => {
  const ids = MODEL_IDS.filter(
    (id) => cards.get(id)!.checkbox.checked && !cards.get(id)!.checkbox.disabled,
  );
  if (ids.length === 0) return;
  for (const id of ids) {
    const els = cards.get(id)!;
    els.error.hidden = true;
    els.progress.hidden = false;
    els.checkbox.disabled = true;
  }
  downloadNote.hidden = false;
  updateDownloadButton();
  sendPlayerCmd({ type: 'download', modelIds: ids });
});

document.getElementById('select-all')!.addEventListener('click', () => {
  for (const [, els] of cards) {
    if (!els.checkbox.disabled) els.checkbox.checked = true;
  }
  updateDownloadButton();
});

async function init(): Promise<void> {
  for (const id of MODEL_IDS) cardsEl.append(buildCard(id));
  cardsEl.addEventListener('change', updateDownloadButton);
  const settings = await getSettings();
  for (const id of MODEL_IDS) {
    if (settings.downloaded[id]) markInstalled(id, true);
  }
  updateDownloadButton();
  // Pick up any download already running in the player context.
  sendPlayerCmd({ type: 'get-status' });
}

void init();

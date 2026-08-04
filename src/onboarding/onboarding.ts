import type { Message, ModelId, PlayerCommand } from '../lib/messages';
import { getSettings } from '../lib/settings';
import { openSidebar, primeSidebar } from '../lib/sidebar';

primeSidebar();
import { MODELS, MODEL_IDS } from '../engines/registry';
import { installedModels, isInstalled, uninstall } from '../engines/model-storage';

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

/** The background owns the downloaded flags; this page can see the actual
 *  files, so it reports what it found and lets the background persist it. */
function reportInstalled(installed: Partial<Record<ModelId, boolean>>): void {
  void chrome.runtime
    .sendMessage({ target: 'background', type: 'installed-state', installed } satisfies Message)
    .catch(() => {});
}

const fmtMB = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

interface CardEls {
  checkbox: HTMLInputElement;
  progress: HTMLDivElement;
  fill: HTMLDivElement;
  pct: HTMLSpanElement;
  installed: HTMLDivElement;
  remove: HTMLButtonElement;
  error: HTMLDivElement;
}
const cards = new Map<ModelId, CardEls>();
/** Models with a download running: their card belongs to the progress handler
 *  and must not be reset by an installed-state refresh. */
const downloading = new Set<ModelId>();

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
    remove: card.querySelector('.remove')!,
    error: card.querySelector('.dl-error')!,
  };
  cards.set(id, els);

  card.querySelector<HTMLButtonElement>('.try')!.addEventListener('click', (e) => {
    e.preventDefault();
    openSidebar(); // synchronously, while this click's gesture is live
    sendPlayerCmd({ type: 'speak', text: SAMPLE_TEXT, title: 'Sample', modelId: id });
  });
  els.remove.addEventListener('click', (e) => {
    e.preventDefault();
    confirmRemoval(id);
  });
  return card;
}

/** Deleting a few hundred megabytes deserves a second click, but not a modal:
 *  the button asks for confirmation in place and reverts if it's ignored. */
const pendingRemoval = new Map<ModelId, ReturnType<typeof setTimeout>>();

function confirmRemoval(id: ModelId): void {
  const els = cards.get(id)!;
  const timer = pendingRemoval.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingRemoval.delete(id);
    void removeModel(id);
    return;
  }
  els.remove.textContent = `Delete ${fmtMB(MODELS[id].sizeBytes)}? Click again`;
  els.remove.classList.add('confirm');
  pendingRemoval.set(
    id,
    setTimeout(() => {
      pendingRemoval.delete(id);
      resetRemoveButton(id);
    }, 6000),
  );
}

function resetRemoveButton(id: ModelId): void {
  const els = cards.get(id)!;
  const pending = pendingRemoval.get(id);
  if (pending !== undefined) {
    // Never leave an armed confirmation behind a re-labelled button.
    clearTimeout(pending);
    pendingRemoval.delete(id);
  }
  els.remove.textContent = 'Remove';
  els.remove.disabled = false;
  els.remove.classList.remove('confirm');
}

function markInstalled(id: ModelId, installed: boolean): void {
  const els = cards.get(id)!;
  els.installed.hidden = !installed;
  els.checkbox.disabled = installed;
  els.progress.hidden = true;
  resetRemoveButton(id);
  if (installed) {
    els.checkbox.checked = false;
    els.error.hidden = true;
  }
  // "You're all set" belongs to a real install, not to an optimistic flag.
  doneSection.hidden = !MODEL_IDS.some((m) => !cards.get(m)!.installed.hidden);
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
  const meta = MODELS[id];
  const els = cards.get(id)!;
  els.remove.disabled = true;
  els.remove.classList.remove('confirm');
  els.remove.textContent = 'Removing…';
  // Unload the engine first — it may still be reading the files being deleted.
  sendPlayerCmd({ type: 'model-changed' });
  try {
    await uninstall(id);
    if (await isInstalled(id)) throw new Error('the files are still on disk');
  } catch (err) {
    els.error.hidden = false;
    els.error.textContent = `Could not remove ${meta.shortName}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    resetRemoveButton(id);
    return;
  }
  reportInstalled({ [id]: false });
  markInstalled(id, false);
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg?.target !== 'ui' || msg.type !== 'download-progress') return;
  const { modelId, loaded, total, done, error } = msg.progress;
  const els = cards.get(modelId);
  if (!els) return;
  if (error) {
    downloading.delete(modelId);
    els.progress.hidden = true;
    els.error.hidden = false;
    els.error.textContent = `Download failed: ${error} — select and try again.`;
    els.checkbox.disabled = false;
    updateDownloadButton();
    return;
  }
  if (done) {
    // The worker verifies the files are on disk before sending this, and the
    // background persists the downloaded flag on the same event.
    downloading.delete(modelId);
    markInstalled(modelId, true);
    return;
  }
  // A download resumed from a previous visit: reflect that it's running.
  downloading.add(modelId);
  els.progress.hidden = false;
  els.installed.hidden = true;
  els.error.hidden = true;
  els.checkbox.disabled = true;
  const pct = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
  els.fill.style.width = `${pct}%`;
  els.pct.textContent = `${fmtMB(loaded)} / ${fmtMB(total)}`;
});

downloadBtn.addEventListener('click', () => {
  const ids = MODEL_IDS.filter(
    (id) => cards.get(id)!.checkbox.checked && !cards.get(id)!.checkbox.disabled,
  );
  if (ids.length === 0) return;
  for (const id of ids) {
    const els = cards.get(id)!;
    downloading.add(id);
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

/** Believes the files on disk, not the settings flag: a model whose cache was
 *  evicted — or whose download died half way — must not claim to be installed. */
async function refreshInstalled(): Promise<void> {
  const [settings, installed] = await Promise.all([getSettings(), installedModels(MODEL_IDS)]);
  let stale = false;
  for (const id of MODEL_IDS) {
    if (Boolean(settings.downloaded[id]) !== installed[id]) stale = true;
    if (!downloading.has(id)) markInstalled(id, installed[id]);
  }
  if (stale) reportInstalled(installed);
}

async function init(): Promise<void> {
  for (const id of MODEL_IDS) cardsEl.append(buildCard(id));
  cardsEl.addEventListener('change', updateDownloadButton);
  updateDownloadButton();
  await refreshInstalled();
  // Pick up any download already running in the player context.
  sendPlayerCmd({ type: 'get-status' });
}

void init();

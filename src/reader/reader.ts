// The "Now Reading" view: live audio visualizer + Apple Music-style lyrics
// (auto-scrolling, current line highlighted, neighbors faded/blurred).
import { VIZ_PORT } from '../lib/messages';
import type { Message, ModelId, PlayerCommand, PlayerStatus, VizMessage } from '../lib/messages';
import { getSettings, mutateSettings, onSettingsChanged } from '../lib/settings';
import { MODELS, MODEL_IDS } from '../engines/registry';

const lyricsEl = document.getElementById('lyrics') as HTMLElement;
const emptyEl = document.getElementById('empty') as HTMLElement;
const transportEl = document.getElementById('transport') as HTMLElement;
const titleEl = document.getElementById('title') as HTMLElement;
const eyebrowEl = document.getElementById('eyebrow') as HTMLElement;
const canvas = document.getElementById('viz') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

let lines: HTMLElement[] = [];
/** Raw chunk text, kept so a model switch can re-speak the remainder. */
let chunkStrings: string[] = [];
let activeIndex = -1;
let userScrollUntil = 0;
let transcriptKey = '';
let lastStatus: PlayerStatus | null = null;

function sendPlayerCmd(cmd: PlayerCommand): void {
  void chrome.runtime
    .sendMessage({ target: 'background', type: 'player-cmd', cmd } satisfies Message)
    .catch(() => {});
}
document.getElementById('pause')!.addEventListener('click', () => sendPlayerCmd({ type: 'pause' }));
document.getElementById('resume')!.addEventListener('click', () => sendPlayerCmd({ type: 'resume' }));
document.getElementById('stop')!.addEventListener('click', () => sendPlayerCmd({ type: 'stop' }));

// -- Transcript / lyrics ----------------------------------------------------

function setTranscript(chunks: string[] | null, title?: string): void {
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
  const line = lines[index];
  if (line && Date.now() > userScrollUntil) {
    lyricsEl.scrollTo({
      top: line.offsetTop - lyricsEl.clientHeight / 2 + line.clientHeight / 2,
      behavior: 'smooth',
    });
  }
}

// Pause auto-scroll for a few seconds when the user scrolls on their own.
for (const evt of ['wheel', 'touchmove'] as const) {
  lyricsEl.addEventListener(evt, () => {
    userScrollUntil = Date.now() + 4000;
  }, { passive: true });
}

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
  const active = s.state === 'speaking' || s.state === 'paused';
  transportEl.hidden = !active;
  document.getElementById('pause')!.hidden = s.state !== 'speaking';
  document.getElementById('resume')!.hidden = s.state !== 'paused';

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
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg?.target !== 'ui') return;
  if (msg.type === 'status') renderStatus(msg.status);
  if (msg.type === 'transcript') {
    setTranscript(msg.chunks, msg.title);
    connectPort(); // the player context just (re)appeared
  }
});

// -- Model selector ---------------------------------------------------------

const modelBtn = document.getElementById('model-btn') as HTMLButtonElement;
const modelNameEl = document.getElementById('model-name') as HTMLElement;
const modelMenu = document.getElementById('model-menu') as HTMLElement;
let selectedModel: ModelId | null = null;

function renderModelButton(): void {
  modelNameEl.textContent = selectedModel ? MODELS[selectedModel].shortName : 'None installed';
}

async function openModelMenu(): Promise<void> {
  const s = await getSettings();
  const downloaded = MODEL_IDS.filter((id) => s.downloaded[id]);
  modelMenu.replaceChildren();
  for (const id of downloaded) {
    const item = document.createElement('button');
    item.className = 'model-item';
    const check = document.createElement('span');
    check.className = 'check';
    check.textContent = id === selectedModel ? '✓' : '';
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
    item.addEventListener('click', () => void chooseModel(id));
    modelMenu.append(item);
  }
  const manage = document.createElement('button');
  manage.className = 'model-item manage';
  manage.textContent = downloaded.length === 0 ? 'Install a voice model…' : 'Manage models…';
  manage.addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
  });
  modelMenu.append(manage);
  modelMenu.hidden = false;
}

async function chooseModel(id: ModelId): Promise<void> {
  modelMenu.hidden = true;
  if (id === selectedModel) return;
  selectedModel = id;
  renderModelButton();
  await mutateSettings(() => ({ selectedModel: id }));
  const reading =
    lastStatus !== null && (lastStatus.state === 'speaking' || lastStatus.state === 'paused');
  if (reading && chunkStrings.length > 0) {
    // Re-speak the remainder with the new model, starting at the active line.
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

modelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (modelMenu.hidden) void openModelMenu();
  else modelMenu.hidden = true;
});
document.addEventListener('click', (e) => {
  if (!modelMenu.hidden && !modelMenu.contains(e.target as Node)) modelMenu.hidden = true;
});

void getSettings().then((s) => {
  selectedModel = s.selectedModel;
  renderModelButton();
});
onSettingsChanged((s) => {
  selectedModel = s.selectedModel;
  renderModelButton();
});

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
connectPort();
sendPlayerCmd({ type: 'get-status' });
requestAnimationFrame(draw);

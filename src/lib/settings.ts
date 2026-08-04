import type { ModelId } from './messages';

export interface Settings {
  /** Model used for reading; null until one is downloaded */
  selectedModel: ModelId | null;
  /** Models with all files verified in cache */
  downloaded: Partial<Record<ModelId, boolean>>;
  /** Per-model voice id (only models with multiple voices) */
  voices: Partial<Record<ModelId, string>>;
  /** Playback speed, 0.5–2.0 (pitch-preserving) */
  speed: number;
  onboarded: boolean;
}

const DEFAULTS: Settings = {
  selectedModel: null,
  downloaded: {},
  voices: {},
  speed: 1,
  onboarded: false,
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...((stored['settings'] ?? {}) as Partial<Settings>) };
}

// All writes go through one promise chain so concurrent read-modify-writes in
// the same context can't interleave and lose each other's fields (e.g. two
// download-complete events both merging into a stale `downloaded` map).
let writes: Promise<unknown> = Promise.resolve();

export function mutateSettings(fn: (s: Settings) => Partial<Settings>): Promise<Settings> {
  const run = writes.then(async () => {
    const current = await getSettings();
    const next = { ...current, ...fn(current) };
    await chrome.storage.local.set({ settings: next });
    return next;
  });
  writes = run.catch(() => undefined);
  return run;
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return mutateSettings(() => patch);
}

export function onSettingsChanged(fn: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['settings']) {
      fn({ ...DEFAULTS, ...((changes['settings'].newValue ?? {}) as Partial<Settings>) });
    }
  });
}

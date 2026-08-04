// Injected into the tab the reading view is looking at, but only while that
// view is showing its call-to-action cards. Reports what the user has
// highlighted so the card can fill with it.
//
// The port is the whole lifecycle: the view holds one end, so its closing —
// or moving to another tab, or starting a read — drops the connection, and
// this script unhooks itself. Without that signal an injected watcher would
// keep listening on every page for the life of the tab, long after anyone
// cared.
import { SELECTION_PORT } from '../lib/messages';
import type { SelectionMessage } from '../lib/messages';
import { previewSelection } from '../lib/cta-state';

/** Selection changes fire continuously while a drag is in progress. */
const DEBOUNCE_MS = 200;

declare global {
  // eslint-disable-next-line no-var
  var __melonArmSelectionWatch: (() => void) | undefined;
}

if (!globalThis.__melonArmSelectionWatch) {
  let port: chrome.runtime.Port | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** null, not '', so the first report always goes out — including the
   *  report that nothing is highlighted. */
  let lastText: string | null = null;

  function report(): void {
    if (!port) return;
    const text = window.getSelection()?.toString() ?? '';
    if (text === lastText) return;
    lastText = text;
    try {
      port.postMessage(previewSelection(text) satisfies SelectionMessage);
    } catch {
      // Port closed between the check above and here.
    }
  }

  function onSelectionChange(): void {
    clearTimeout(timer);
    timer = setTimeout(report, DEBOUNCE_MS);
  }

  // executeScript re-runs this file top to bottom on every injection, so
  // arming has to be idempotent rather than merely guarded.
  globalThis.__melonArmSelectionWatch = () => {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: SELECTION_PORT });
    } catch {
      return; // Extension reloaded out from under the page.
    }
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      lastText = null;
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onSelectionChange);
    });
    document.addEventListener('selectionchange', onSelectionChange);
    report(); // whatever is already highlighted, before any change happens
  };
}

globalThis.__melonArmSelectionWatch?.();

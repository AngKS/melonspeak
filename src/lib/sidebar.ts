// Opening the reading sidebar requires a LIVE user gesture in both browsers,
// and any await before the call spends the gesture:
// - Chrome rejects sidePanel.open() from runtime.onMessage listeners
//   (crbug.com/355266358), so UI pages open it themselves, synchronously in
//   their own click handlers; primeSidebar() caches the window id at page
//   load so no await is needed inside the gesture. The background may only
//   open it from a direct user-action handler (contextMenus.onClicked).
// - Firefox's sidebarAction.open() likewise only runs inside a user-action
//   handler.
// Failures are swallowed by design: reading must work even if the panel
// can't open.

type FirefoxGlobals = {
  browser?: { sidebarAction?: { open(): Promise<void> } };
};

let cachedWindowId: number | undefined;

/** Call at page load so openSidebar() needs no awaits inside the gesture. */
export function primeSidebar(): void {
  try {
    void chrome.windows
      .getCurrent()
      .then((w) => (cachedWindowId = w.id ?? undefined))
      .catch(() => {});
  } catch {
    // No windows API in this context.
  }
}

/**
 * Open the Now Reading sidebar. Must be called synchronously inside a user
 * gesture. Returns false when no sidebar API exists so callers can fall back
 * (e.g. to a reader tab).
 */
export function openSidebar(tabId?: number): boolean {
  const ff = globalThis as unknown as FirefoxGlobals;
  try {
    if (typeof chrome.sidePanel?.open === 'function') {
      if (tabId !== undefined) {
        void chrome.sidePanel.open({ tabId }).catch(() => {});
      } else if (cachedWindowId !== undefined) {
        void chrome.sidePanel.open({ windowId: cachedWindowId }).catch(() => {});
      }
      return true;
    }
    if (ff.browser?.sidebarAction?.open) {
      void ff.browser.sidebarAction.open().catch(() => {});
      return true;
    }
  } catch {
    // Gesture expired or API unavailable.
  }
  return false;
}

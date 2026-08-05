// Opening the reading sidebar requires a LIVE user gesture in both browsers,
// and any await before the call spends the gesture:
// - Chrome rejects sidePanel.open() from runtime.onMessage listeners
//   (crbug.com/355266358). The background may only open it from a direct
//   user-action handler — contextMenus.onClicked.
// - Firefox's sidebarAction.open()/toggle() likewise only run inside a
//   user-action handler; action.onClicked is one.
// Failures are swallowed by design: reading must work even if the panel
// can't open.

type FirefoxGlobals = {
  browser?: { sidebarAction?: { open(): Promise<void>; toggle(): Promise<void> } };
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

/** True when this browser has a sidebar API at all. */
export function hasSidebarAction(): boolean {
  return Boolean((globalThis as unknown as FirefoxGlobals).browser?.sidebarAction);
}

/** Firefox's toolbar-button handler: a second click closes the sidebar again,
 *  which is what users expect of a button that opens a panel. Chrome never
 *  reaches this — setPanelBehavior makes the browser open the panel itself and
 *  action.onClicked stops firing. */
export function toggleSidebar(): void {
  const ff = globalThis as unknown as FirefoxGlobals;
  try {
    void ff.browser?.sidebarAction?.toggle().catch(() => {});
  } catch {
    // Gesture expired or API unavailable.
  }
}

/**
 * Open the Now Reading sidebar. Must be called synchronously inside a user
 * gesture. Without a tab id it falls back to the window primeSidebar() cached,
 * which is how the onboarding tab's sample player opens it. Returns false when
 * no sidebar API exists.
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

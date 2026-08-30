// The panel footer: the only place a read can be started now that the popup is
// gone. Three mutually exclusive modes (setup / idle / reading) chosen by
// resolveFooterMode, plus the split "Read this page ▾" button that lets a new
// read replace one already playing.
import type { Message, PlayerCommand, PlayerState } from '../lib/messages';
import { resolveFooterMode } from '../lib/reader-controls';

export interface ReadActionsDeps {
  sendPlayerCmd(cmd: PlayerCommand): void;
  openOnboarding(): void;
  /** The tab to read, or undefined to let the background choose. */
  readTargetTabId(): number | undefined;
}

export interface ReadActions {
  update(state: PlayerState, hasModel: boolean): void;
  closeMenu(): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Exported because the "this tab moved" toast starts a read too, and it
 *  targets the tab that moved rather than whichever tab is in front. */
export function requestRead(mode: 'page' | 'selection', tabId: number | undefined): void {
  void chrome.runtime
    .sendMessage({
      target: 'background',
      type: mode === 'page' ? 'read-page' : 'read-selection',
      ...(tabId === undefined ? {} : { tabId }),
    } satisfies Message)
    .catch(() => {});
}

export function initReadActions(deps: ReadActionsDeps): ReadActions {
  const setupActions = $('setup-actions');
  const readingActions = $('reading-actions');
  const readMenu = $('read-menu');
  const readMore = $<HTMLButtonElement>('read-more');

  let menuOpen = false;
  function setMenuOpen(open: boolean): void {
    menuOpen = open;
    readMenu.hidden = !open;
    readMore.setAttribute('aria-expanded', String(open));
  }
  const closeMenu = () => setMenuOpen(false);

  $('finish-setup').addEventListener('click', () => deps.openOnboarding());

  // Only the reading-state controls: when nothing is playing the CTA cards own
  // starting a read, and they carry live previews the footer cannot.
  for (const id of ['read-page-live', 'menu-read-page']) {
    $(id).addEventListener('click', () => {
      closeMenu();
      requestRead('page', deps.readTargetTabId());
    });
  }
  $('menu-read-selection').addEventListener('click', () => {
    closeMenu();
    requestRead('selection', deps.readTargetTabId());
  });

  $('pause').addEventListener('click', () => deps.sendPlayerCmd({ type: 'pause' }));
  $('resume').addEventListener('click', () => deps.sendPlayerCmd({ type: 'resume' }));
  $('stop').addEventListener('click', () => deps.sendPlayerCmd({ type: 'stop' }));

  readMore.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenuOpen(!menuOpen);
  });
  document.addEventListener('click', (e) => {
    if (menuOpen && !readMenu.contains(e.target as Node)) closeMenu();
  });

  return {
    closeMenu,
    update(state, hasModel) {
      // 'idle' shows neither block: the CTA cards above are the idle UI.
      const mode = resolveFooterMode(state, hasModel);
      setupActions.hidden = mode !== 'setup';
      readingActions.hidden = mode !== 'reading';
      if (mode !== 'reading') closeMenu();
      // Pause and resume swap in place; the player guards both commands, but
      // showing the wrong one would still be a lie about what will happen.
      $('pause').hidden = state !== 'speaking';
      $('resume').hidden = state !== 'paused';
    },
  };
}

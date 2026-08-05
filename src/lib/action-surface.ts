export type ActionSurface = 'side-panel' | 'sidebar' | 'popup';

export interface ActionSurfaceCaps {
  hasSidePanel: boolean;
  hasSidebarAction: boolean;
}

/** Which surface the toolbar button should open.
 *
 *  'popup' is the last resort, not a preference: it means neither browser API
 *  exists, so the reading view is served as the action popup rather than
 *  leaving the controls unreachable. */
export function resolveActionSurface(caps: ActionSurfaceCaps): ActionSurface {
  if (caps.hasSidePanel) return 'side-panel';
  if (caps.hasSidebarAction) return 'sidebar';
  return 'popup';
}

/**
 * Extension-relative URL that also works inside plain Web Workers, where
 * chrome.* APIs are unavailable: workers load from the extension origin, so
 * the URL can be derived from their own location.
 */
export function extUrl(path: string): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return new URL('/' + path.replace(/^\//, ''), self.location.origin).href;
}

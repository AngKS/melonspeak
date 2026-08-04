// Guarantees offline operation for engine-internal fetches (e.g. kokoro-js
// voice embeddings): HuggingFace GETs are served cache-first from our model
// cache, and voice files fetched online are captured into it.
const CACHE_NAME = 'melonspeak-models';

let installed = false;

export function installHfFetchCache(): void {
  if (installed) return;
  installed = true;
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const isHfGet =
      url.includes('huggingface.co') && (!init?.method || init.method.toUpperCase() === 'GET');
    if (!isHfGet) return orig(input, init);
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return hit.clone();
    const res = await orig(input, init);
    if (res.ok && /\.(bin|json)$/.test(new URL(url).pathname)) {
      // Awaited on purpose: these are small (voice embeddings, configs) and a
      // fire-and-forget put loses the race against the download worker being
      // terminated the moment the last fetch resolves.
      await cache.put(url, res.clone()).catch(() => {});
    }
    return res;
  }) as typeof fetch;
}

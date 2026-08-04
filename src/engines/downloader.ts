// Streaming downloader: HuggingFace CDN → Cache API, with progress.
// Files are fetched once during onboarding; afterwards everything is offline.
import type { ProgressFn } from './types';

const CACHE_NAME = 'melonspeak-models';

export interface RemoteFile {
  url: string;
  /** Expected size, used for progress totals before headers arrive. */
  bytes: number;
}

export async function fetchToCache(files: RemoteFile[], onProgress: ProgressFn): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  let doneBytes = 0;
  for (const file of files) {
    const name = file.url.split('/').pop() ?? file.url;
    if (await cache.match(file.url)) {
      doneBytes += file.bytes;
      onProgress(doneBytes, total, name);
      continue;
    }
    const res = await fetch(file.url);
    if (!res.ok || !res.body) {
      throw new Error(`Download failed (${res.status}) for ${name}`);
    }
    const chunks: BlobPart[] = [];
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress(Math.min(doneBytes + received, total), total, name);
    }
    await cache.put(
      file.url,
      new Response(new Blob(chunks), {
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    doneBytes += file.bytes;
    onProgress(Math.min(doneBytes, total), total, name);
  }
  onProgress(total, total);
}

export async function cachedBuffer(url: string): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE_NAME);
  const res = await cache.match(url);
  if (!res) throw new Error(`Model file missing from local storage: ${url.split('/').pop()}`);
  return res.arrayBuffer();
}

export async function allCached(files: RemoteFile[]): Promise<boolean> {
  const cache = await caches.open(CACHE_NAME);
  for (const f of files) {
    if (!(await cache.match(f.url))) return false;
  }
  return true;
}

export async function removeCached(files: RemoteFile[]): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  for (const f of files) {
    await cache.delete(f.url);
  }
}

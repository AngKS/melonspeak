// Injected on demand into the active tab. Defines a global the background
// script then calls with the extraction mode; injecting twice is harmless.
import { Readability } from '@mozilla/readability';
import { serializeReadable } from '../lib/readable-text';

export interface ExtractResult {
  ok: boolean;
  text: string;
  title: string;
  error?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __melonExtract: ((mode: 'page' | 'selection') => ExtractResult) | undefined;
}

if (!globalThis.__melonExtract) {
  globalThis.__melonExtract = (mode) => {
    const title = document.title || location.hostname;
    if (mode === 'selection') {
      const text = window.getSelection()?.toString() ?? '';
      return text.trim()
        ? { ok: true, text, title }
        : { ok: false, text: '', title, error: 'No text is highlighted on this page.' };
    }
    try {
      const clone = document.cloneNode(true) as Document;
      const article = new Readability(clone).parse();
      if (article?.content) {
        // Never article.textContent: it has no separators between block
        // elements, which glues words together and erases every paragraph
        // boundary on pages without inter-tag whitespace.
        const doc = new DOMParser().parseFromString(article.content, 'text/html');
        const text = serializeReadable(doc.body);
        // Readability keeps ONE top-scoring container and structurally drops
        // content outside it — leading paragraphs, text near tables
        // (mozilla/readability#901, #922, #437). When its yield is a small
        // slice of the visible page, prefer the whole page over silently
        // losing sections.
        const bodyLen = (document.body?.innerText ?? '').length;
        if (text.trim().length >= Math.max(500, bodyLen * 0.2)) {
          return { ok: true, text, title: article.title || title };
        }
      }
    } catch {
      // fall through to plain innerText
    }
    const text = document.body?.innerText ?? '';
    return text.trim()
      ? { ok: true, text, title }
      : { ok: false, text: '', title, error: 'No readable text found on this page.' };
  };
}

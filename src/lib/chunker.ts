/**
 * Split text into speakable chunks at sentence boundaries.
 *
 * Guarantees: no text is dropped or duplicated; order preserved; every
 * chunk is <= maxLen characters (hard-split as a last resort). Chunks
 * never merge across paragraph breaks, so headings and list items are
 * spoken as their own units.
 */

import { normalizeForTTS } from './tts-normalize';

const PARA = '\u2029'; // internal paragraph marker, never present in page text

interface Piece {
  text: string;
  startsParagraph: boolean;
}

/** Abbreviations that end in a period without ending a sentence (list from
 *  the read-aloud extension), plus single-letter initials like "J." */
const ABBREV =
  /\b(?:Adm|Assn|Ave|Blvd|Bldg|Brig|Capt|Cmdr|Col|Comdr|Corp|Cpl|Ct|Dept|Dr|Drs|Fig|Figs|Fr|Ft|Gen|Gov|Hon|Inc|Jr|Lieut|Ln|Lt|Ltd|Maj|Messrs|Mmes|Mr|Mrs|Ms|Mt|Mx|No|Nos|Pl|Pres|Prof|Rd|Rep|Reps|Rev|Sen|Sens|Sgt|Sr|St|Ste|Univ|Jan|Feb|Mar|Apr|Aug|Sep|Sept|Oct|Nov|Dec|dept|ed|eds|est|fig|figs|misc|pp|ref|refs|vol|vols|vs|[A-Za-z])\.$/;

/**
 * Locale-aware sentence segmentation (Intl.Segmenter, Chrome 87+/Firefox
 * 125+) with a regex fallback, then re-merge of false splits after known
 * abbreviations — a chunk boundary in the middle of "Dr. Smith" makes the
 * engine misread both halves.
 */
function splitSentences(paragraph: string): string[] {
  let parts: string[];
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    parts = Array.from(segmenter.segment(paragraph), (s) => s.segment);
  } else {
    // End punctuation (optionally a closing quote/bracket) then a space.
    parts = paragraph.split(/(?<=[.!?…]["'”’)\]]?)\s+/);
  }
  const out: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const prev = out[out.length - 1];
    if (prev !== undefined && ABBREV.test(prev)) {
      out[out.length - 1] = `${prev} ${part}`;
    } else {
      out.push(part);
    }
  }
  return out;
}

export function chunkText(text: string, maxLen = 300): string[] {
  const normalized = normalizeForTTS(text)
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/\s*\n\s*\n\s*/g, PARA)
    .replace(/[^\S\u2029]+/g, ' ')
    .trim();
  if (!normalized) return [];

  const pieces: Piece[] = [];
  for (const [pi, paragraph] of normalized.split(PARA).entries()) {
    const sentences = splitSentences(paragraph);
    for (const [si, sentence] of sentences.entries()) {
      const startsParagraph = si === 0 && pi > 0;
      if (sentence.length <= maxLen) {
        pieces.push({ text: sentence, startsParagraph });
        continue;
      }
      // Overlong sentence: split at clause punctuation, then spaces, then hard.
      let rest = sentence;
      let first = true;
      while (rest.length > maxLen) {
        const window = rest.slice(0, maxLen);
        let cut = Math.max(
          window.lastIndexOf(', '),
          window.lastIndexOf('; '),
          window.lastIndexOf(': '),
          window.lastIndexOf('— '),
          window.lastIndexOf('– '),
        );
        if (cut > maxLen * 0.3) {
          cut += 1; // keep the punctuation on the left side
        } else {
          cut = window.lastIndexOf(' ');
          if (cut <= 0) cut = maxLen;
        }
        pieces.push({ text: rest.slice(0, cut).trim(), startsParagraph: first && startsParagraph });
        rest = rest.slice(cut).trim();
        first = false;
      }
      if (rest) pieces.push({ text: rest, startsParagraph: false });
    }
  }

  // Merge short sentences into fuller chunks for natural prosody, but never
  // across paragraph boundaries.
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (!current) {
      current = piece.text;
    } else if (!piece.startsParagraph && current.length + 1 + piece.text.length <= maxLen) {
      current += ' ' + piece.text;
    } else {
      chunks.push(current);
      current = piece.text;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

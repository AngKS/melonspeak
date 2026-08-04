// Supertonic text front-end: normalization and unicode tokenization, ported
// from the official demo (supertone-inc/supertonic web/helper.js, MIT) —
// English only. Kept free of onnxruntime imports so it is unit-testable.

const REPLACEMENTS: [string, string][] = [
  ['‑', '-'],
  ['_', ' '],
  ['“', '"'],
  ['”', '"'],
  ['‘', "'"],
  ['’', "'"],
  ['´', "'"],
  ['`', "'"],
  ['[', ' '],
  [']', ' '],
  ['|', ' '],
  ['/', ' '],
  ['#', ' '],
  ['→', ' '],
  ['←', ' '],
  ['@', ' at '],
  ['e.g.,', 'for example, '],
  ['i.e.,', 'that is, '],
];
const EMOJI =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;

export function preprocessText(text: string): string {
  let t = text.normalize('NFKD').replace(EMOJI, '');
  // Supertonic never splits at dashes/semicolons, so its duration predictor
  // under-allocates for the whole span and words get swallowed — the
  // maintainer-confirmed fix (supertonic#31) is to make them sentence breaks.
  // Unspaced en dashes stay hyphens: they are ranges (1999–2004).
  t = t.replace(/\s*—\s*/g, '. ').replace(/\s+–\s+/g, '. ').replace(/–/g, '-');
  t = t.replace(/;/g, '.');
  for (const [from, to] of REPLACEMENTS) t = t.replaceAll(from, to);
  t = t.replace(/[♥☆♡©\\]/g, '');
  t = t.replace(/ ([,.!?;:'])/g, '$1');
  while (t.includes('""')) t = t.replace('""', '"');
  while (t.includes("''")) t = t.replace("''", "'");
  t = t.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(t)) t += '.';
  return `<en>${t}</en>`;
}

/**
 * One id per character (iterating by codepoint, not UTF-16 unit — astral
 * characters must not decompose into surrogate garbage). Codepoints beyond
 * the indexer map to -1, the model's unknown token.
 */
export function textToIds(text: string, indexer: number[]): BigInt64Array {
  const chars = Array.from(text);
  const ids = new BigInt64Array(chars.length);
  for (let j = 0; j < chars.length; j++) {
    const cp = chars[j].codePointAt(0)!;
    ids[j] = BigInt(cp < indexer.length ? indexer[cp] : -1);
  }
  return ids;
}

// Text cleanup for TTS, in two layers:
//
// normalizeForTTS — lossy-but-visible cleanup applied before chunking (the
// reader displays this text): invisible characters, odd spaces, URLs,
// decorative repeats, markdown-link artifacts.
//
// expandForSpeech — applied per chunk at synthesis time only, so the display
// keeps the original digits/symbols. All three engines have documented gaps
// here (kokoro-js's normalizer lacks misaki's symbol/number handling;
// Supertone recommends external normalization for numbers; espeak-family
// voices mispronounce or silently skip digit forms absent from training
// data). The espeak failure mode for tokens it can't resolve is a SILENT
// skip, which reads as "the model skipped words".

/** Unicode format characters (soft hyphen, zero-width chars, BOM,
 *  directional marks, …). None of the engines' own normalizers strip these
 *  (confirmed from kokoro-js source) and web pages accumulate them inside
 *  words, so they are removed before anything else. */
const INVISIBLE = /\p{Cf}/gu;

/** No-break space, typographic fixed-width spaces, narrow no-break space,
 *  medium mathematical space, ideographic space. Become plain spaces so word
 *  boundaries survive. */
const ODD_SPACES = /[  -   　]/g;

/** Markdown-shaped link artifacts ([label](target)) from extracted pages:
 *  keep only the visible label. */
const MD_LINKS = /\[([^\]]+)\]\([^)]*\)/g;

/** Bare URL up to (but not including) trailing punctuation, so a sentence
 *  ending in a URL keeps its full stop. Spoken as a placeholder — engines
 *  spell URLs out character by character otherwise. */
const URLS = /\b(?:https?:\/\/|www\.)\S+?(?=[.,;:!?)\]]*(?:\s|$))/gi;

/** Runs of 4+ identical non-digit characters ("......", "!!!!!", "AAAA")
 *  collapse to three; digits stay intact (years, IDs). */
const REPEATS = /([^\d\s])\1{3,}/g;

export function normalizeForTTS(text: string): string {
  return text
    .replace(INVISIBLE, '')
    .replace(ODD_SPACES, ' ')
    .replace(MD_LINKS, '$1')
    .replace(URLS, '(link)')
    .replace(REPEATS, '$1$1$1');
}

// ---------------------------------------------------------------------------
// Number → words
// ---------------------------------------------------------------------------

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', ' thousand', ' million', ' billion', ' trillion'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  return n % 10 ? `${tens}-${ONES[n % 10]}` : tens;
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (!hundreds) return belowHundred(rest);
  return rest ? `${ONES[hundreds]} hundred ${belowHundred(rest)}` : `${ONES[hundreds]} hundred`;
}

function integerToWords(digits: string): string {
  if (digits.length > 15) {
    // ID-like digit strings: read digit by digit.
    return [...digits].map((d) => ONES[Number(d)]).join(' ');
  }
  const n = Number(digits);
  if (n === 0) return 'zero';
  const groups: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 1000)) groups.push(rest % 1000);
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i]) parts.push(belowThousand(groups[i]) + SCALES[i]);
  }
  return parts.join(' ');
}

/** "1984" → "nineteen eighty-four" for year-like standalone integers. */
function yearToWords(n: number): string {
  if (n === 2000) return 'two thousand';
  if (n > 2000 && n < 2010) return `two thousand ${ONES[n - 2000]}`;
  const pair = Math.floor(n / 100);
  const sub = n % 100;
  if (sub === 0) return `${belowHundred(pair)} hundred`;
  if (sub < 10) return `${belowHundred(pair)} oh ${ONES[sub]}`;
  return `${belowHundred(pair)} ${belowHundred(sub)}`;
}

function numberToWords(raw: string, yearHeuristic = false): string {
  const digits = raw.replace(/,/g, '');
  const [int, frac] = digits.split('.');
  if (frac !== undefined) {
    return `${integerToWords(int)} point ${[...frac].map((d) => ONES[Number(d)]).join(' ')}`;
  }
  const n = Number(int);
  // Comma grouping ("1,234") marks a quantity, never a year.
  if (yearHeuristic && !raw.includes(',') && int.length === 4 && n >= 1100 && n <= 2099) {
    return yearToWords(n);
  }
  return integerToWords(int);
}

const ORDINAL_IRREGULAR: Record<string, string> = {
  one: 'first',
  two: 'second',
  three: 'third',
  five: 'fifth',
  eight: 'eighth',
  nine: 'ninth',
  twelve: 'twelfth',
};

function ordinalToWords(raw: string): string {
  const words = integerToWords(raw.replace(/,/g, ''));
  const parts = words.split(' ');
  const lastWord = parts[parts.length - 1];
  const hyphen = lastWord.split('-');
  const last = hyphen[hyphen.length - 1];
  const ord =
    ORDINAL_IRREGULAR[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  hyphen[hyphen.length - 1] = ord;
  parts[parts.length - 1] = hyphen.join('-');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// expandForSpeech
// ---------------------------------------------------------------------------

const CURRENCY: Record<string, [string, string]> = {
  $: ['dollar', 'dollars'],
  '£': ['pound', 'pounds'],
  '€': ['euro', 'euros'],
  '¥': ['yen', 'yen'],
  '₹': ['rupee', 'rupees'],
};

/** Digits not glued to letters (Q3, COVID-19 handled by espeak better than
 *  by us splitting them apart). */
const NUM = String.raw`\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?`;

export function expandForSpeech(text: string): string {
  let t = text;
  // Clock times: 3:45 → three forty-five.
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (m, h: string, min: string) => {
    const hour = Number(h);
    const minute = Number(min);
    if (hour > 23 || minute > 59) return m;
    if (minute === 0) return `${belowHundred(hour)} o'clock`;
    if (minute < 10) return `${belowHundred(hour)} oh ${ONES[minute]}`;
    return `${belowHundred(hour)} ${belowHundred(minute)}`;
  });
  // Currency: symbol + amount → amount + unit words.
  t = t.replace(
    new RegExp(String.raw`([$£€¥₹])\s?(${NUM})`, 'g'),
    (_m, sym: string, amount: string) => {
      const [singular, plural] = CURRENCY[sym];
      const unit = amount.replace(/,/g, '') === '1' ? singular : plural;
      return `${numberToWords(amount)} ${unit}`;
    },
  );
  // Ordinals: 3rd → third.
  t = t.replace(/(?<![\w.])(\d+)(?:st|nd|rd|th)\b/g, (_m, n: string) => ordinalToWords(n));
  // Percent: 12% → twelve percent.
  t = t.replace(
    new RegExp(String.raw`(?<![\w.])(${NUM})\s?%`, 'g'),
    (_m, n: string) => `${numberToWords(n)} percent`,
  );
  // Remaining standalone numbers (year-like 4-digit integers read as years).
  t = t.replace(
    new RegExp(String.raw`(?<![\w.,])(${NUM})(?![\w%])`, 'g'),
    (_m, n: string) => numberToWords(n, true),
  );
  t = t.replace(/&/g, ' and ').replace(/@/g, ' at ');
  t = t.replace(/\s+/g, ' ').replace(/ ([,.!?;:])/g, '$1').trim();
  // Blocks without terminal punctuation (headings) make engines run on or
  // trail off; close them.
  if (t && !/[.!?…;:,]$/.test(t)) t += '.';
  return t;
}

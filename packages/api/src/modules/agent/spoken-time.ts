// Spoken clock times → digits, for the reminder parser:
// "at fourteen thirty" → "at 14:30", "half past two pm" → "2:30 pm",
// "quarter to four" → "3:45", "nine oh five" → "9:05", "14.30" → "14:30".
// Only clock-like phrases are touched ("I have two cats" stays as it is).

const SMALL = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };

/** "twenty five" / "twenty-five" / "seven" → number (0–59), or null. */
function wordsToNumber(phrase: string): number | null {
  const words = phrase.toLowerCase().replace(/-/g, " ").trim().split(/\s+/);
  if (words.length === 1) {
    const small = SMALL.indexOf(words[0]!);
    if (small >= 0) return small;
    return TENS[words[0]!] ?? null;
  }
  if (words.length === 2 && TENS[words[0]!] !== undefined) {
    const unit = SMALL.indexOf(words[1]!);
    if (unit >= 1 && unit <= 9) return TENS[words[0]!]! + unit;
  }
  return null;
}

/** Longest first, so "twenty three" wins over "twenty" and "seventeen" over "seven". */
const NUMBER_WORD = [
  ...Object.keys(TENS).flatMap((t) => SMALL.slice(1, 10).map((u) => `${t}[\\s-]${u}`)),
  ...Object.keys(TENS),
  ...[...SMALL].sort((a, b) => b.length - a.length),
].join("|");

const N = `(${NUMBER_WORD})`;
/** Minutes after an hour word: "thirty", "oh five", "hundred" (= :00). */
const MIN = `(oh\\s+(?:${SMALL.slice(1, 10).join("|")})|hundred|${NUMBER_WORD})`;
const AMPM = `(?:\\s*(am|pm|a\\.m\\.|p\\.m\\.))?`;
/** Words after which a bare "fourteen thirty" is a time. */
const LEAD = `(^|\\b(?:at|by|around|from|until|till|before|after|me)\\s+)`;

const pad = (n: number): string => String(n).padStart(2, "0");
const ampm = (raw: string | undefined): string =>
  raw ? ` ${raw.replace(/\./g, "").toLowerCase()}` : "";

function hourOf(word: string): number | null {
  const h = wordsToNumber(word);
  return h !== null && h <= 23 ? h : null;
}

function minuteOf(word: string): number | null {
  const w = word.toLowerCase();
  if (w === "hundred") return 0;
  const oh = w.match(/^oh\s+(\w+)$/);
  if (oh) {
    const m = wordsToNumber(oh[1]!);
    return m !== null && m >= 1 && m <= 9 ? m : null;
  }
  const m = wordsToNumber(w);
  return m !== null && m >= 10 && m <= 59 ? m : null;
}

export function normaliseSpokenTimes(text: string): string {
  let out = text;

  // "14.30" after a time preposition.
  out = out.replace(/\b(at|by|around|from|until|till)\s+(\d{1,2})\.(\d{2})\b/gi, (m, p, h, mm) =>
    Number(h) <= 23 && Number(mm) <= 59 ? `${p} ${h}:${mm}` : m,
  );

  out = out.replace(/\b(at|by|around)\s+(?:noon|midday)\b/gi, "$1 12:00");
  out = out.replace(/\b(at|by|around)\s+midnight\b/gi, "$1 0:00");

  // "half past two", "quarter past three", "(a) quarter to four", "ten past six".
  out = out.replace(
    new RegExp(`\\b(?:a\\s+)?(half|quarter|${NUMBER_WORD})\\s+(past|to)\\s+${N}\\b${AMPM}`, "gi"),
    (m, mins: string, dir: string, hourWord: string, suffix?: string) => {
      const hour = hourOf(hourWord);
      const minutes =
        mins.toLowerCase() === "half"
          ? 30
          : mins.toLowerCase() === "quarter"
            ? 15
            : wordsToNumber(mins);
      if (hour === null || hour > 12 || minutes === null || minutes < 1 || minutes > 30) return m;
      if (dir.toLowerCase() === "past") return `${hour}:${pad(minutes)}${ampm(suffix)}`;
      const before = hour === 1 ? 12 : hour - 1;
      return `${before}:${pad(60 - minutes)}${ampm(suffix)}`;
    },
  );

  // "three o'clock".
  out = out.replace(
    new RegExp(`\\b${N}\\s+o'?\\s?clock\\b${AMPM}`, "gi"),
    (m, h: string, s?: string) => {
      const hour = hourOf(h);
      return hour === null ? m : `${hour}:00${ampm(s)}`;
    },
  );

  // "at fourteen thirty", "me nine oh five", "eighteen hundred".
  out = out.replace(
    new RegExp(`${LEAD}${N}\\s+${MIN}\\b${AMPM}`, "gi"),
    (m, lead: string, h: string, mm: string, s?: string) => {
      const hour = hourOf(h);
      const minutes = minuteOf(mm);
      return hour === null || minutes === null ? m : `${lead}${hour}:${pad(minutes)}${ampm(s)}`;
    },
  );

  // "at seven pm", "at seven".
  out = out.replace(
    new RegExp(
      `\\b(at|by|around)\\s+${N}\\b${AMPM}(?!\\s*(?:\\w+\\s+)?(?:minutes?|hours?|days?))`,
      "gi",
    ),
    (m, p: string, h: string, s?: string) => {
      const hour = hourOf(h);
      return hour === null ? m : `${p} ${hour}${ampm(s)}`;
    },
  );

  return out;
}

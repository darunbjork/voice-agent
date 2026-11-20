// Parses spoken translation requests. Pure, no network.
//
// Used by both the keyword classifier (slots) and the translate tool, so the
// two can never disagree. Live bug: "Translate good morning to Swedish" only
// matched "translate X in Y"; the tool then fell back to a default phrase and
// translated "hello". Nothing here ever invents a phrase or a language.

export type TranslationLanguage = { name: string; code: string };

export type TranslateRequest = {
  original?: string;
  /** Target language. */
  language?: TranslationLanguage;
  /** Source language, only when the user said it ("from English"). */
  source?: TranslationLanguage;
};

/** Lowercase language name → ISO 639-1 code. */
export const TRANSLATION_LANGUAGES: Readonly<Record<string, string>> = {
  swedish: "sv",
  norwegian: "no",
  danish: "da",
  finnish: "fi",
  icelandic: "is",
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  dutch: "nl",
  polish: "pl",
  czech: "cs",
  greek: "el",
  turkish: "tr",
  russian: "ru",
  ukrainian: "uk",
  arabic: "ar",
  persian: "fa",
  farsi: "fa",
  hebrew: "he",
  hindi: "hi",
  urdu: "ur",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  mandarin: "zh",
  cantonese: "yue",
  thai: "th",
  vietnamese: "vi",
  indonesian: "id",
  kurdish: "ku",
  somali: "so",
};

const CODE_TO_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TRANSLATION_LANGUAGES)
    .filter(([name]) => name !== "farsi" && name !== "mandarin")
    .map(([name, code]) => [code, name]),
);

/** The reply when the phrase or the language is missing — never a guess. */
export const TRANSLATE_CLARIFY_REPLY =
  "What would you like me to translate, and into which language?";

/**
 * "Swedish", "swedish", "sv", or a likely speech-to-text slip ("Sweidhs")
 * → { name: "swedish", code: "sv" }. Unknown words return null.
 */
export function resolveLanguage(raw: string): TranslationLanguage | null {
  const word = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-zà-ÿ]/g, "");
  if (!word) return null;
  const exact = TRANSLATION_LANGUAGES[word];
  if (exact) return { name: word, code: exact };
  const byCode = CODE_TO_NAME[word];
  if (byCode) return { name: byCode, code: word };
  // Fuzzy only for longer words, so "in it" / "in me" never become a language.
  if (word.length < 5) return null;
  const close = Object.keys(TRANSLATION_LANGUAGES).find(
    (name) => Math.abs(name.length - word.length) <= 2 && damerauLevenshtein(word, name) <= 2,
  );
  return close ? { name: close, code: TRANSLATION_LANGUAGES[close]! } : null;
}

/** Words that stand in for a phrase but are not one ("translate this"). */
const PLACEHOLDER =
  /^(?:this|that|it|something|anything|please|a\s+(?:word|phrase|sentence)|for\s+me|me)$/i;

const LEAD_IN =
  /^(?:(?:okay|ok|so|hey|please|can\s+you|could\s+you|would\s+you|i\s+want\s+you\s+to)[,.!]?\s+)*(?:(?:translation|translate)[:.,!]?\s*)?/i;

/** Strip lead-ins, quotes, "the word …", trailing "please" and punctuation. */
export function cleanPhrase(raw: string): string {
  let s = raw.trim();
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s
      .replace(LEAD_IN, "")
      .replace(/^(?:the\s+)?(?:word|phrase|sentence|expression|term)\s+/i, "")
      .replace(/[,\s]+please$/i, "")
      .replace(/[?.!,;:]+$/, "")
      .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "")
      .trim();
  }
  return PLACEHOLDER.test(s) ? "" : s;
}

const LANG = String.raw`([A-Za-zÀ-ÿ]+)`;
const END = String.raw`\s*(?:,?\s*please)?\s*[?.!]*\s*$`;
const rx = (source: string): RegExp => new RegExp(source, "i");

/**
 * Phrase-and-language patterns, most specific first. Each yields
 * [phrase, language] (or [language, phrase] when `swap`).
 */
/**
 * Speech recognition adds punctuation mid-sentence ("What does, lunch mean in
 * Danish?"). Commas, semicolons and colons become spaces; quotes are kept.
 */
export function normaliseTranscript(text: string): string {
  return text
    .replace(/[,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "translate X from A to B" / "X from A to B" → phrase, source, target. */
const FROM_TO = rx(
  String.raw`^(?:.*?\btranslate\s+)?(.+?)\s+from\s+${LANG}\s+(?:to|into)\s+${LANG}${END}`,
);

const FULL_PATTERNS: Array<{ re: RegExp; swap?: boolean; guard?: (phrase: string) => boolean }> = [
  // translate X to / into / in Y
  { re: rx(String.raw`\btranslate\s+(.+?)\s+(?:to|into|in)\s+${LANG}${END}`) },
  // translate to Y: X   /   translate into Y X
  {
    re: rx(String.raw`\btranslate\s+(?:this\s+)?(?:to|into)\s+${LANG}\s*[:,-]?\s+(.+?)${END}`),
    swap: true,
  },
  // how do you / would I say X in Y
  {
    re: rx(
      String.raw`\bhow\s+(?:do|would|can|could|should|does)\s+(?:you|i|we|one|someone)\s+say\s+(.+?)\s+in\s+${LANG}${END}`,
    ),
  },
  // what does X mean in Y  (also "dose", "does the word X mean", "what's X mean")
  {
    re: rx(
      String.raw`\b(?:what(?:'s|\s+)?(?:is|dose|does|do)|is|dose|does|do)\s+(.+?)\s+means?\s+in\s+${LANG}\b`,
    ),
  },
  // what is the meaning of X in Y
  { re: rx(String.raw`\bwhat(?:'s|\s+is)\s+the\s+meaning\s+of\s+(.+?)\s+in\s+${LANG}\b`) },
  // what's the Swedish word for X
  {
    re: rx(
      String.raw`\bwhat(?:'s|\s+is)\s+the\s+${LANG}\s+(?:word|phrase|term|expression)\s+for\s+(.+?)${END}`,
    ),
    swap: true,
  },
  // what is X in Y
  { re: rx(String.raw`\bwhat(?:'s|\s+is)\s+(.+?)\s+in\s+${LANG}${END}`) },
  // say X in Y
  { re: rx(String.raw`\bsay\s+(.+?)\s+in\s+${LANG}${END}`) },
  // X in Y (please) — short phrases that are not themselves a command or question
  {
    re: rx(String.raw`^(.+?)\s+in\s+${LANG}${END}`),
    guard: (phrase) =>
      phrase.split(/\s+/).length <= 6 &&
      !/^(?:remind|set|add|create|schedule|summari[sz]e|recap|what|how|who|where|when|why|which|tell|is|are|can|could|do|does)\b/i.test(
        phrase,
      ),
  },
];

/**
 * Extracts the phrase and target language from a translation request.
 * Either may be missing; callers must ask rather than guess.
 */
export function parseTranslateRequest(text: string): TranslateRequest {
  const input = normaliseTranscript(text);
  if (!input) return {};

  const fromTo = input.match(FROM_TO);
  if (fromTo?.[1] && fromTo[2] && fromTo[3]) {
    const original = cleanPhrase(fromTo[1]);
    const source = resolveLanguage(fromTo[2]);
    const language = resolveLanguage(fromTo[3]);
    if (original && source && language) return { original, language, source };
  }

  for (const { re, swap, guard } of FULL_PATTERNS) {
    const m = input.match(re);
    if (!m?.[1] || !m[2]) continue;
    const [rawPhrase, rawLang] = swap ? [m[2], m[1]] : [m[1], m[2]];
    const language = resolveLanguage(rawLang);
    const original = cleanPhrase(rawPhrase);
    if (!language || !original) continue;
    if (guard && !guard(original)) continue;
    return { original, language };
  }

  // Partial requests: say what we did understand so the tool can ask.
  const partial: TranslateRequest = {};
  for (const m of input.matchAll(/\b(?:to|into|in)\s+([A-Za-zÀ-ÿ]+)/gi)) {
    const language = resolveLanguage(m[1] ?? "");
    if (language) {
      partial.language = language;
      break;
    }
  }
  const bare = input.match(/\btranslate\s+(.+?)$/i);
  if (bare?.[1]) {
    const phrase = cleanPhrase(bare[1].replace(/\s+(?:to|into|in)\s+[A-Za-zÀ-ÿ]+\s*[?.!]*$/i, ""));
    if (phrase && !/^(?:to|into|in)\b/i.test(phrase)) partial.original = phrase;
  }
  return partial;
}

function damerauLevenshtein(left: string, right: string): number {
  const d = Array.from({ length: left.length + 1 }, (_, row) =>
    Array.from({ length: right.length + 1 }, (_, col) => (row === 0 ? col : col === 0 ? row : 0)),
  );
  for (let row = 1; row <= left.length; row++) {
    for (let col = 1; col <= right.length; col++) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      d[row]![col] = Math.min(
        d[row - 1]![col]! + 1,
        d[row]![col - 1]! + 1,
        d[row - 1]![col - 1]! + cost,
      );
      if (
        row > 1 &&
        col > 1 &&
        left[row - 1] === right[col - 2] &&
        left[row - 2] === right[col - 1]
      ) {
        d[row]![col] = Math.min(d[row]![col]!, d[row - 2]![col - 2]! + 1);
      }
    }
  }
  return d[left.length]![right.length]!;
}

/**
 * A reply that is just a language ("French", "In French, please", "into
 * danish.") → that language; anything else → null.
 */
export function parseLanguageAnswer(text: string): TranslationLanguage | null {
  const words = normaliseTranscript(text)
    .replace(/[?.!]+/g, " ")
    .replace(/\b(?:in|into|to|please|thanks|thank\s+you|okay|ok|um|uh|so|the|language)\b/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length === 1 ? resolveLanguage(words[0]!) : null;
}

/**
 * "What does good night mean?" with no language → "good night". Acronyms and
 * codes (RAG, MCP, n8n, GPT-4) are definition questions, not translations.
 */
export function parseMeaningWithoutLanguage(text: string): string | null {
  const m = normaliseTranscript(text).match(
    /^(?:what\s+(?:does|do|dose)|what's)\s+(.+?)\s+means?\s*[?.!]*$/i,
  );
  if (!m?.[1]) return null;
  const phrase = cleanPhrase(m[1]);
  if (!phrase || /\d/.test(phrase) || /\b[A-Z]{2,}\b/.test(phrase)) return null;
  return phrase;
}

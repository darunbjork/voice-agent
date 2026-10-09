// packages/api/src/modules/agent/intent.classifier.ts
// Pure keyword classifier. No LLM, no network, no async.
// The slow path (Gemini) lives in agent.service.ts.

import type { IntentType } from "@voice-agent/shared-types";
import { extractReminderDetails } from "./reminder-parser.js";

export type ClassifyResult = {
  intent: IntentType;
  viaFastPath: true;
  confidence: 1;
  slots: Record<string, string>;
};

type KeywordRule = {
  intent: IntentType;
  patterns: RegExp[];
  extract?: (text: string) => Record<string, string>;
};

// Ordered — first match wins.
const KEYWORD_RULES: KeywordRule[] = [
  {
    intent: "weather",
    patterns: [
      /\b(weather|temperature|forecast|rain|sunny|cloudy|humid)\b(?!\s+means?\s+in\b)/i,
      /\bhow\s+(hot|cold|warm)\b/i,
      /\bwhat(?:'s|\s+is)\s+the\s+weather\b/i,
    ],
    extract: (text: string): Record<string, string> => {
      const m = text.match(/\b(?:in|for|at)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)\s*[?.!]?/i);
      return m?.[1] ? { location: m[1].trim() } : {};
    },
  },
  {
    intent: "reminder",
    patterns: [
      /\b(remind|reminder|remember\s+to|set\s+a\s+reminder)\b/i,
      /\bdon'?t\s+let\s+me\s+forget\b/i,
    ],
    extract: (text: string): Record<string, string> => {
      const { note, time } = extractReminderDetails(text);
      return {
        ...(note ? { note } : {}),
        ...(time ? { time } : {}),
      };
    },
  },
  {
    intent: "translate",
    patterns: [
      /\b(translate|translation)\b/i,
      /\bsay\s+.+\s+in\s+\w+/i,
      /\bin\s+(spanish|french|swedish|german|italian|portuguese|japanese|mandarin|chinese)\b/i,
    ],
    extract: (text: string): Record<string, string> => {
      const m = text.match(/\b(?:translate|say)\s+(.+?)\s+in\s+(\w+)/i);
      if (m?.[1] && m[2]) {
        const original = m[1].replace(/^["'"]|["'"]$/g, "").trim();
        return { original, toLang: m[2].toLowerCase() };
      }
      const clean = (s: string): string => s.replace(/^["'"]|["'"]$/g, "").trim();
      const w = text.match(
        /\b(?:what(?:'s|\s+)?)?(?:is|dose|does|do)\s+(?:the\s+)?(?:word\s+)?(.+?)\s+means?\s+in\s+(\w+)/i,
      );
      if (w?.[1] && w[2]) {
        return { original: clean(w[1]), toLang: w[2].toLowerCase() };
      }
      const wof = text.match(
        /\b(?:what(?:'s|\s+)?)?is\s+(?:the\s+)?meaning\s+of\s+(.+?)\s+in\s+(\w+)/i,
      );
      if (wof?.[1] && wof[2]) {
        return { original: clean(wof[1]), toLang: wof[2].toLowerCase() };
      }
      return {};
    },
  },
  {
    intent: "summarize",
    patterns: [
      /\b(summarize|summary|summarise|tldr|tl;dr|recap)\b/i,
      /\bgive\s+me\s+the\s+(main\s+)?points\b/i,
    ],
  },
  {
    intent: "help",
    patterns: [
      /\b(help|what\s+can\s+you\s+do|commands|capabilities|how\s+do\s+i)\b/i,
      /\bwhat\s+are\s+your\s+features\b/i,
    ],
  },
];

const TRANSLATION_LANGUAGES: Record<string, string> = {
  swedish: "sv",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  japanese: "ja",
  mandarin: "zh",
  chinese: "zh",
};

/**
 * Pure keyword classifier. Returns null on miss.
 * Caller decides what to do on miss (typically: fall through to Gemini).
 */
export function classifyByKeywords(text: string): ClassifyResult | null {
  const normalised = text.trim();
  if (!normalised) return null;

  const meaningTranslation = extractMeaningTranslation(normalised);
  if (meaningTranslation) {
    return {
      intent: "translate",
      viaFastPath: true,
      confidence: 1,
      slots: meaningTranslation,
    };
  }

  for (const rule of KEYWORD_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(normalised)) {
        const slots = rule.extract?.(normalised) ?? {};
        return {
          intent: rule.intent,
          viaFastPath: true,
          confidence: 1,
          slots,
        };
      }
    }
  }
  return null;
}

function extractMeaningTranslation(text: string): Record<string, string> | null {
  const meaning =
    text.match(
      /\b(?:what(?:'s|\s+)?(?:is|dose|does|do)|(?:is|dose|does|do))\s+(?:the\s+)?(?:word\s+)?(.+?)\s+means?\s+in\s+([a-z]+)\b/i,
    ) ?? text.match(/\bwhat\s+is\s+(?:the\s+)?meaning\s+of\s+(.+?)\s+in\s+([a-z]+)\b/i);
  if (!meaning?.[1] || !meaning[2]) return null;

  const toLang = resolveTranslationLanguage(meaning[2]);
  if (!toLang) return null;

  const original = meaning[1].replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  return original ? { original, toLang } : null;
}

function resolveTranslationLanguage(input: string): string | null {
  const language = input.toLowerCase();
  if (TRANSLATION_LANGUAGES[language]) return language;

  const match = Object.entries(TRANSLATION_LANGUAGES).find(
    ([name]) => damerauLevenshtein(language, name) <= 2,
  );
  return match?.[0] ?? null;
}

function damerauLevenshtein(left: string, right: string): number {
  const distances = Array.from({ length: left.length + 1 }, (_, row) =>
    Array.from({ length: right.length + 1 }, (_, column) =>
      row === 0 ? column : column === 0 ? row : 0,
    ),
  );

  for (let row = 1; row <= left.length; row++) {
    for (let column = 1; column <= right.length; column++) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      distances[row]![column] = Math.min(
        distances[row - 1]![column]! + 1,
        distances[row]![column - 1]! + 1,
        distances[row - 1]![column - 1]! + substitutionCost,
      );
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        distances[row]![column] = Math.min(
          distances[row]![column]!,
          distances[row - 2]![column - 2]! + 1,
        );
      }
    }
  }

  return distances[left.length]![right.length]!;
}

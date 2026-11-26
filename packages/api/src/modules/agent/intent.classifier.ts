// packages/api/src/modules/agent/intent.classifier.ts
// Pure keyword classifier. No LLM, no network, no async.
// The slow path (Gemini) lives in agent.service.ts.

import type { IntentType } from "@voice-agent/shared-types";
import { extractReminderDetails } from "./reminder-parser.js";
import { extractWeatherLocation } from "./location.js";
import {
  TRANSLATION_LANGUAGES,
  parseTranslateRequest,
  type TranslateRequest,
} from "./translate-request.js";

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
      const location = extractWeatherLocation(text);
      return location ? { location } : {};
    },
  },
  {
    intent: "reminder",
    // An explicit instruction only. The bare word "reminder" is not enough:
    // "What does reminder do in this application?" used to create a reminder.
    patterns: [
      /\bremind\s+me\b/i,
      /\b(?:set|add|create|make|schedule|save)\s+(?:me\s+)?(?:a\s+|an\s+)?reminder\b/i,
      /^\s*(?:please\s+)?remember\s+to\b/i,
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
      // "… in Swedish", unless it is another command ("Summarize everything in French").
      new RegExp(
        String.raw`^(?!.*\b(?:summari[sz]e|summary|recap|remind)\b).*\bin\s+(?:${Object.keys(TRANSLATION_LANGUAGES).join("|")})\b`,
        "i",
      ),
    ],
    // Whatever was understood; the tool asks for anything missing.
    extract: (text: string): Record<string, string> => {
      const { original, language } = parseTranslateRequest(text);
      return {
        ...(original ? { original } : {}),
        ...(language ? { toLang: language.name } : {}),
      };
    },
  },
  {
    intent: "summarize",
    patterns: [
      /\b(summarize|summary|summarise|tldr|tl;dr|recap)\b/i,
      /\bgive\s+me\s+the\s+(main\s+)?points\b/i,
    ],
    extract: (text: string): Record<string, string> =>
      CONVERSATION_SCOPE.some((p) => p.test(text)) ? { scope: "conversation" } : {},
  },
  // No "help" keyword rule: help is matched by HELP_REQUEST below, before
  // these rules. The word "help" elsewhere is not enough (C7): "Thanks for
  // the help", "help me write a cover letter", "How do I cook rice?".
];

/**
 * Explicit requests for the help menu: "help" on its own, "what can you do?",
 * "list commands", "what are your features?". Whole-word, and the main ask of
 * the utterance (anchored), so "help" inside another request does not count.
 */
const HELP_REQUEST: RegExp[] = [
  /^\s*(?:please\s+)?help(?:\s+me)?(?:,?\s+please)?\s*[.!?]*\s*$/i,
  /^\s*(?:i\s+need\s+help|(?:can|could)\s+you\s+help(?:\s+me)?)\s*[.!?]*\s*$/i,
  /\bwhat\s+(?:else\s+)?can\s+you\s+(?:do|help\s+(?:me\s+)?with)\b/i,
  /\bwhat\s+are\s+your\s+(?:features|capabilities|commands)\b/i,
  /\bwhat\s+commands\b/i,
  /^\s*(?:please\s+)?(?:list|show)(?:\s+me)?\s+(?:the\s+|your\s+|all\s+(?:the\s+)?|available\s+)*(?:commands|features|capabilities)\b/i,
  /^\s*(?:commands|capabilities|features)\s*[.!?]*\s*$/i,
  /\bhow\s+do\s+i\s+use\s+(?:this(?:\s+app)?|you|the\s+app)\s*[.!?]*\s*$/i,
];

export function isExplicitHelpRequest(text: string): boolean {
  return HELP_REQUEST.some((p) => p.test(text));
}

/**
 * Questions about words in one language ("synonyms in English for native",
 * "another word for happy", "rephrase this") are not translations: they go to
 * the LLM. Live: they were translated English → English.
 */
const WORD_QUESTION =
  /\b(?:synonyms?|antonyms?|rephrase|paraphrase|reword|(?:another|other)\s+words?\s+for|similar\s+words?|words?\s+(?:that\s+mean|close\s+in\s+meaning))\b/i;

export function isWordQuestion(text: string): boolean {
  return WORD_QUESTION.test(text);
}

/** "Summarize everything we discussed" → summarise the session, not this utterance. */
const CONVERSATION_SCOPE: RegExp[] = [
  /\b(?:everything|all|what)\b[^.?!]*\b(?:we|we've|we\s+have|i|i've|i\s+have|you)\b[^.?!]*\b(?:discuss\w*|talk\w*|said|say|covered|chatted|asked|went\s+over)\b/i,
  /\b(?:our|this|the)\s+(?:whole\s+|entire\s+)?(?:conversation|chat|discussion|session|talk)\b/i,
  /\bso\s+far\b/i,
];

const FEATURE = String.raw`(?:reminders?|weather|translat\w*|summar\w*|recap|help)`;
const FEATURE_NOUN = String.raw`(?:\s+(?:feature|function|tool|command|option|button|mode))?`;

/**
 * Questions ABOUT a feature ("What does reminder do in this application?",
 * "How does the weather feature work?") must not run the feature. They go to
 * Gemini, which answers as help/general.
 */
const FEATURE_QUESTION: RegExp[] = [
  new RegExp(
    String.raw`\bwhat\s+(?:does|do|is|are)\s+(?:the\s+|your\s+)?${FEATURE}${FEATURE_NOUN}\s+(?:do|does|for|mean)\b`,
    "i",
  ),
  new RegExp(
    String.raw`\bhow\s+(?:does|do|can|would)\s+(?:i\s+use\s+)?(?:the\s+|your\s+)?${FEATURE}${FEATURE_NOUN}\s*(?:work|works|\?|$)`,
    "i",
  ),
  new RegExp(
    String.raw`\bhow\s+(?:do|can)\s+i\s+(?:use|set\s+up)\s+(?:the\s+|a\s+)?${FEATURE}`,
    "i",
  ),
  new RegExp(
    String.raw`\b(?:explain|tell\s+me\s+about|describe)\s+(?:the\s+|your\s+)?${FEATURE}${FEATURE_NOUN}\s+(?:feature|function|tool|command|in\s+this\s+app)`,
    "i",
  ),
  new RegExp(
    String.raw`\b${FEATURE}\s+(?:feature|function|tool|command|option)s?\b[^?]*\b(?:do|work|does)\b`,
    "i",
  ),
];

export function isFeatureQuestion(text: string): boolean {
  return FEATURE_QUESTION.some((p) => p.test(text));
}

/**
 * Pure keyword classifier. Returns null on miss.
 * Caller decides what to do on miss (typically: fall through to Gemini).
 */
export function classifyByKeywords(text: string): ClassifyResult | null {
  const normalised = text.trim();
  if (!normalised) return null;

  if (isExplicitHelpRequest(normalised)) {
    return { intent: "help", viaFastPath: true, confidence: 1, slots: {} };
  }

  const wordQuestion = isWordQuestion(normalised);

  // A complete translation request (phrase + known language) wins first:
  // "What does weather mean in Swedish?" is a translation, not weather.
  const translation: TranslateRequest = wordQuestion ? {} : parseTranslateRequest(normalised);
  if (translation.original && translation.language) {
    return {
      intent: "translate",
      viaFastPath: true,
      confidence: 1,
      slots: { original: translation.original, toLang: translation.language.name },
    };
  }

  if (isFeatureQuestion(normalised)) return null;

  for (const rule of KEYWORD_RULES) {
    if (wordQuestion && rule.intent === "translate") continue;
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

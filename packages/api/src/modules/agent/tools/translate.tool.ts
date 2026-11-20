import type { TranslateCard } from "@voice-agent/shared-types";
import { env } from "../../../env.js";
import { generateToolText } from "../gemini.tools.js";
import {
  TRANSLATE_CLARIFY_REPLY,
  cleanPhrase,
  parseTranslateRequest,
  resolveLanguage,
} from "../translate-request.js";

export type TranslateToolInput = {
  userText: string;
  slots: Record<string, string>;
};

export type TranslateToolResult = {
  /** Null when we had to ask what to translate or into which language. */
  card: TranslateCard | null;
  replyHint: string;
};

const DEMO_DICTIONARY: Record<string, Record<string, string>> = {
  sv: {
    hello: "hej",
    "hello world": "hej världen",
    high: "hög",
    sleep: "sova",
    goodbye: "hej då",
    thanks: "tack",
    "good morning": "god morgon",
  },
  es: {
    hello: "hola",
    "hello world": "hola mundo",
    goodbye: "adiós",
    thanks: "gracias",
  },
  fr: {
    hello: "bonjour",
    "hello world": "bonjour le monde",
    goodbye: "au revoir",
    thanks: "merci",
  },
  de: {
    hello: "hallo",
    "hello world": "hallo welt",
    goodbye: "auf wiedersehen",
    thanks: "danke",
  },
};

const TRANSLATE_SYSTEM_PROMPT =
  "You are a translation engine. Reply with only the translated text. " +
  "No quotes, no explanations, no romanization.";

export async function translateTool(input: TranslateToolInput): Promise<TranslateToolResult> {
  // Never substitute a default phrase or language: ask instead.
  const parsed = parseTranslateRequest(input.userText);
  const original = cleanPhrase(input.slots.original ?? "") || parsed.original;
  const language = resolveLanguage(input.slots.toLang ?? "") ?? parsed.language;
  if (!original || !language) {
    return { card: null, replyHint: TRANSLATE_CLARIFY_REPLY };
  }

  const toLang = language.code;
  const fromLang = "en";
  const display = language.name.charAt(0).toUpperCase() + language.name.slice(1);

  const dictHit = DEMO_DICTIONARY[toLang]?.[original.toLowerCase()] ?? null;

  let translated = dictHit;
  if (!env.VOICE_MOCK) {
    const live = await liveTranslate(original, display);
    if (live !== null) translated = live;
  }

  const card: TranslateCard = {
    type: "translate",
    original,
    translated: translated ?? `${original} (no translation available yet)`,
    fromLang,
    toLang,
  };

  return {
    card,
    replyHint: translated
      ? `${original} in ${display} is ${translated}.`
      : env.VOICE_MOCK
        ? `I do not have a translation for "${original}" to ${display} in the demo dictionary yet.`
        : `I do not have a translation for "${original}" to ${display} yet.`,
  };
}

async function liveTranslate(original: string, display: string): Promise<string | null> {
  const prompt = `Translate from English to ${display}:\n${original}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await generateToolText(TRANSLATE_SYSTEM_PROMPT, prompt);
      return stripWrappingQuotes(out);
    } catch {
      // Provider unavailable, over budget, or circuit open — retry once for
      // transient spikes, then fall back to the demo dictionary (and its
      // honest "no translation" reply).
      if (attempt === 0) await new Promise((r) => setTimeout(r, 700));
    }
  }
  return null;
}

function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^["'“”‘’]+([\s\S]*?)["'“”‘’]+$/);
  return (m?.[1] ?? trimmed).trim();
}

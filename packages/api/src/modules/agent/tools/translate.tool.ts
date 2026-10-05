import type { TranslateCard } from "@voice-agent/shared-types";
import { env } from "../../../env.js";
import { generateToolText } from "../gemini.tools.js";

export type TranslateToolInput = {
  userText: string;
  slots: Record<string, string>;
};

export type TranslateToolResult = {
  card: TranslateCard;
  replyHint: string;
};

const DEMO_DICTIONARY: Record<string, Record<string, string>> = {
  sv: {
    hello: "hej",
    "hello world": "hej världen",
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

const LANG_DISPLAY: Record<string, string> = {
  sv: "Swedish",
  es: "Spanish",
  fr: "French",
  de: "German",
};

const TRANSLATE_SYSTEM_PROMPT =
  "You are a translation engine. Reply with only the translated text. " +
  "No quotes, no explanations, no romanization.";

export async function translateTool(input: TranslateToolInput): Promise<TranslateToolResult> {
  const original = input.slots.original?.trim() || extractOriginal(input.userText) || "hello";
  const toLang = normaliseLang(input.slots.toLang?.trim() || extractToLang(input.userText) || "sv");
  const fromLang = "en";
  const display = LANG_DISPLAY[toLang] ?? toLang;

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
      : `I do not have a translation for "${original}" to ${display} yet.`,
  };
}

async function liveTranslate(original: string, display: string): Promise<string | null> {
  try {
    const out = await generateToolText(
      TRANSLATE_SYSTEM_PROMPT,
      `Translate from English to ${display}:\n${original}`,
    );
    return stripWrappingQuotes(out);
  } catch {
    // Provider unavailable, over budget, or circuit open — fall back to
    // the demo dictionary (and its honest "no translation" reply).
    return null;
  }
}

function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^["'“”‘’]+([\s\S]*?)["'“”‘’]+$/);
  return (m?.[1] ?? trimmed).trim();
}

function extractOriginal(text: string): string | null {
  const m = text.match(/\b(?:translate|say)\s+["']?(.+?)["']?\s+in\s+\w+/i);
  return m?.[1]?.trim() ?? null;
}

function extractToLang(text: string): string | null {
  const m = text.match(/\bin\s+(swedish|spanish|french|german|sv|es|fr|de)\b/i);
  if (!m?.[1]) return null;
  return normaliseLang(m[1]);
}

function normaliseLang(raw: string): string {
  const lower = raw.toLowerCase();
  const map: Record<string, string> = {
    swedish: "sv",
    spanish: "es",
    french: "fr",
    german: "de",
  };
  return map[lower] ?? lower;
}

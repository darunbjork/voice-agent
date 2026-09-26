import type { TranslateCard } from "@voice-agent/shared-types";

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

export async function translateTool(input: TranslateToolInput): Promise<TranslateToolResult> {
  const original = input.slots.original?.trim() || extractOriginal(input.userText) || "hello";
  const toLang = normaliseLang(input.slots.toLang?.trim() || extractToLang(input.userText) || "sv");
  const fromLang = "en";

  const dict = DEMO_DICTIONARY[toLang];
  const key = original.toLowerCase();
  const hit = dict?.[key];
  const translated = hit ?? `${original} (no translation available yet)`;

  const card: TranslateCard = {
    type: "translate",
    original,
    translated,
    fromLang,
    toLang,
  };

  const display = LANG_DISPLAY[toLang] ?? toLang;

  return {
    card,
    replyHint: hit
      ? `${original} in ${display} is ${hit}.`
      : `I do not have a translation for "${original}" to ${display} yet.`,
  };
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

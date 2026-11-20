import type { TranslateCard } from "@voice-agent/shared-types";
import { env } from "../../../env.js";
import { generateToolText } from "../gemini.tools.js";
import { TRANSLATE_CLARIFY_REPLY, cleanPhrase, resolveLanguage } from "../translate-request.js";
import { extractTranslateRequest } from "../translate-extract.js";

export type TranslateToolInput = {
  userText: string;
  slots: Record<string, string>;
};

export type TranslateToolResult = {
  /** Null when we had to ask what to translate or into which language. */
  card: TranslateCard | null;
  replyHint: string;
  /** What we already know when we had to ask; the next turn can complete it. */
  pending?: Record<string, string>;
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
  da: {
    hello: "hej",
    lunch: "frokost",
    "good morning": "godmorgen",
    "good night": "godnat",
    thanks: "tak",
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
    "good night": "bonne nuit",
    "good morning": "bonjour",
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

const display = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

export async function translateTool(input: TranslateToolInput): Promise<TranslateToolResult> {
  // Slots from a completed pending request are final; otherwise extract
  // phrase / source / target from what the user said (LLM, parser fallback).
  const fromSlots = {
    original: cleanPhrase(input.slots.original ?? "") || undefined,
    language: resolveLanguage(input.slots.toLang ?? "") ?? undefined,
    source: resolveLanguage(input.slots.fromLang ?? "") ?? undefined,
  };
  const complete = fromSlots.original && fromSlots.language;
  const extracted = complete ? {} : await extractTranslateRequest(input.userText);
  const original = fromSlots.original ?? extracted.original;
  const language = fromSlots.language ?? extracted.language;
  const source = fromSlots.source ?? extracted.source;

  // Never substitute a default phrase or language: ask for what is missing.
  if (!original || !language) {
    const pending: Record<string, string> = {
      ...(original ? { original } : {}),
      ...(language ? { toLang: language.name } : {}),
      ...(source ? { fromLang: source.name } : {}),
    };
    const replyHint = original
      ? input.slots.mode === "meaning-or-translate"
        ? `Which language should I translate "${original}" into? Or say "meaning" if you wanted to know what it means.`
        : `Which language should I translate "${original}" into?`
      : language
        ? `What would you like me to translate into ${display(language.name)}?`
        : TRANSLATE_CLARIFY_REPLY;
    return { card: null, replyHint, pending };
  }

  const toLang = language.code;
  const fromLang = source?.code ?? "en";
  const targetName = display(language.name);
  const sourceName = source ? display(source.name) : "English";

  const dictHit =
    fromLang === "en" ? (DEMO_DICTIONARY[toLang]?.[original.toLowerCase()] ?? null) : null;

  let translated = dictHit;
  if (!env.VOICE_MOCK) {
    const live = await liveTranslate(original, targetName, sourceName);
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
      ? `${original} in ${targetName} is ${translated}.`
      : env.VOICE_MOCK
        ? `I do not have a translation for "${original}" to ${targetName} in the demo dictionary yet.`
        : `I do not have a translation for "${original}" to ${targetName} yet.`,
  };
}

async function liveTranslate(
  original: string,
  target: string,
  sourceLang: string,
): Promise<string | null> {
  const prompt = `Translate from ${sourceLang} to ${target}:\n${original}`;
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

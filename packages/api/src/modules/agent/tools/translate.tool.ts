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
  /** Source and target are the same language: not a translation (LLM answers). */
  handOff?: true;
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
  const targetName = display(language.name);
  const handOff: TranslateToolResult = { card: null, replyHint: "", handOff: true };

  let fromLang: string;
  let translated: string | null;
  if (source) {
    // Source stated by the user: used as given.
    fromLang = source.code;
    // Never translate a language into itself: the LLM answers instead.
    if (fromLang === toLang) return handOff;
    translated = fromLang === "en" ? demoTranslate(original, toLang) : null;
    if (!env.VOICE_MOCK) {
      const live = await liveTranslate(original, targetName, display(source.name));
      if (live !== null) translated = live;
    }
  } else {
    // No source stated: detect it, never assume English ("Translate hej into
    // English" is Swedish → English). The live call reports the language it
    // detected; the demo dictionary is the fallback. If neither can tell, or
    // the source is the target ("Translate hello into English"), the LLM answers.
    const live = env.VOICE_MOCK ? null : await liveDetectAndTranslate(original, targetName);
    const demo = live?.fromLang ? null : demoDetect(original, toLang);
    const detectedFrom = live?.fromLang ?? demo?.fromLang;
    if (!detectedFrom || detectedFrom === toLang) return handOff;
    fromLang = detectedFrom;
    translated = live?.translated ?? demo?.translated ?? null;
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

/** English → `toLang` from the demo dictionary. */
function demoTranslate(original: string, toLang: string): string | null {
  return DEMO_DICTIONARY[toLang]?.[original.toLowerCase()] ?? null;
}

/**
 * Detects the source from the demo dictionary: an English entry, or a
 * translation of one ("hej", "god morgon" → Swedish; Swedish is listed first,
 * so "hej" is Swedish rather than Danish). A phrase it does not know is taken
 * as English unless the target is English (then it cannot tell: null).
 */
function demoDetect(
  original: string,
  toLang: string,
): { fromLang: string; translated: string | null } | null {
  const phrase = original.toLowerCase();
  const isEnglish = Object.values(DEMO_DICTIONARY).some((entries) => phrase in entries);
  if (isEnglish) return { fromLang: "en", translated: demoTranslate(phrase, toLang) };
  for (const [lang, entries] of Object.entries(DEMO_DICTIONARY)) {
    const english = Object.entries(entries).find(([, value]) => value === phrase)?.[0];
    if (english === undefined) continue;
    return {
      fromLang: lang,
      translated: toLang === "en" ? english : demoTranslate(english, toLang),
    };
  }
  return toLang === "en" ? null : { fromLang: "en", translated: null };
}

const DETECT_SYSTEM_PROMPT =
  "You are a translation engine. Detect the language of the text, then translate it. " +
  "Reply on one line as <ISO 639-1 code of the detected language>|<translation>. " +
  "No quotes, no explanations, no romanization.";

/**
 * Live translation with source detection. `fromLang` is null when the model
 * did not report a language (then the demo dictionary decides the source);
 * the whole result is null when the call failed.
 */
async function liveDetectAndTranslate(
  original: string,
  target: string,
): Promise<{ fromLang: string | null; translated: string } | null> {
  const out = await callTranslationModel(
    DETECT_SYSTEM_PROMPT,
    `Translate into ${target}:\n${original}`,
  );
  if (out === null || !out.trim()) return null;
  const m = out.trim().match(/^([a-z]{2,3})\s*\|\s*([\s\S]+)$/i);
  if (!m?.[1] || !m[2]) return { fromLang: null, translated: stripWrappingQuotes(out) };
  const fromLang = resolveLanguage(m[1])?.code ?? m[1].toLowerCase();
  return { fromLang, translated: stripWrappingQuotes(m[2]) };
}

async function liveTranslate(
  original: string,
  target: string,
  sourceLang: string,
): Promise<string | null> {
  const out = await callTranslationModel(
    TRANSLATE_SYSTEM_PROMPT,
    `Translate from ${sourceLang} to ${target}:\n${original}`,
  );
  return out === null ? null : stripWrappingQuotes(out);
}

async function callTranslationModel(system: string, prompt: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await generateToolText(system, prompt);
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

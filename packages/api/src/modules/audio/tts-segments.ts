import type { AgentReply } from "@voice-agent/shared-types";

/** One piece of a reply, spoken in `languageCode` (ISO 639-1) when set. */
export type TtsSegment = { text: string; languageCode?: string };

/**
 * Languages ElevenLabs Turbo v2.5 can enforce with `language_code`. Others
 * are spoken without it (the model guesses from the text).
 */
const TURBO_V25_LANGUAGES: ReadonlySet<string> = new Set([
  "en",
  "ja",
  "zh",
  "de",
  "hi",
  "fr",
  "ko",
  "pt",
  "it",
  "es",
  "id",
  "nl",
  "tr",
  "fil",
  "pl",
  "sv",
  "bg",
  "ro",
  "ar",
  "cs",
  "el",
  "fi",
  "hr",
  "ms",
  "sk",
  "da",
  "ta",
  "uk",
  "ru",
  "hu",
  "no",
  "vi",
]);

/**
 * "good night in Swedish is god natt." → the English lead-in, then
 * "god natt." with language "sv", so the phrase is pronounced as Swedish.
 * Every other reply is a single segment without a language.
 */
export function ttsSegmentsFor(reply: AgentReply): TtsSegment[] {
  const whole = [{ text: reply.text }];
  const card = reply.card;
  if (reply.intent !== "translate" || card?.type !== "translate") return whole;
  const lang = card.toLang.toLowerCase();
  if (lang === "en" || !TURBO_V25_LANGUAGES.has(lang) || !card.translated.trim()) return whole;

  const at = reply.text.lastIndexOf(card.translated);
  if (at < 0) return whole;
  const lead = reply.text.slice(0, at).trim();
  const phrase = reply.text.slice(at).trim();
  return lead
    ? [
        { text: lead, languageCode: "en" },
        { text: phrase, languageCode: lang },
      ]
    : [{ text: phrase, languageCode: lang }];
}

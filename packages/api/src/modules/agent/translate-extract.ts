import { z } from "zod";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../../env.js";
import { generateLlm } from "./llm.call.js";
import { toStrictJsonSchema } from "./gemini.schema.js";
import {
  parseTranslateRequest,
  resolveLanguage,
  cleanPhrase,
  normaliseTranscript,
  type TranslateRequest,
} from "./translate-request.js";

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

/** Structured output: what to translate, from which language, into which. */
export const TRANSLATE_EXTRACT_JSON_SCHEMA = {
  type: "object",
  properties: {
    phrase: nullableString,
    sourceLang: nullableString,
    targetLang: nullableString,
  },
  required: ["phrase", "sourceLang", "targetLang"],
} as const;

const TRANSLATE_EXTRACT_STRICT = toStrictJsonSchema(TRANSLATE_EXTRACT_JSON_SCHEMA) as object;

const ExtractionSchema = z.object({
  phrase: z.string().nullable(),
  sourceLang: z.string().nullable(),
  targetLang: z.string().nullable(),
});

export const TRANSLATE_EXTRACT_PROMPT = `You extract a translation request from a voice transcript. The transcript comes from speech recognition, so it may contain stray commas, missing punctuation or filler words.
Return JSON with:
- "phrase": exactly the words the user wants translated, without the request wording around them ("translate", "what does … mean", "how do you say"), without quotes and without punctuation added by speech recognition. null if no phrase is given.
- "sourceLang": the language the phrase is in, in English (e.g. "English"), only if the user says it ("from English"). Otherwise null.
- "targetLang": the language to translate into, in English (e.g. "Danish"), only if the user says it. Otherwise null. Never guess a target language.
Examples:
"What does, lunch mean in Danish?" → {"phrase":"lunch","sourceLang":null,"targetLang":"Danish"}
"Translate lunch from English to Danish" → {"phrase":"lunch","sourceLang":"English","targetLang":"Danish"}
"What does good night mean" → {"phrase":"good night","sourceLang":null,"targetLang":null}
"Translate to Swedish" → {"phrase":null,"sourceLang":null,"targetLang":"Swedish"}`;

/**
 * Phrase / source / target from a translation request. Live, an LLM extracts
 * them (structured output); the deterministic parser fills any gap and is the
 * whole answer in mock mode or when every LLM is down. Never invents a
 * phrase or a language: missing fields stay undefined.
 */
export async function extractTranslateRequest(
  text: string,
  log?: FastifyBaseLogger,
): Promise<TranslateRequest> {
  const cleaned = normaliseTranscript(text);
  const parsed = parseTranslateRequest(cleaned);
  if (env.VOICE_MOCK) return parsed;

  try {
    const result = await generateLlm(
      {
        system: TRANSLATE_EXTRACT_PROMPT,
        user: cleaned,
        temperature: 0,
        json: {
          name: "translate_request",
          schema: TRANSLATE_EXTRACT_JSON_SCHEMA,
          strictSchema: TRANSLATE_EXTRACT_STRICT,
        },
      },
      { log, attemptTimeoutMs: 6_000, hedgeAfterMs: 2_500 },
    );
    const json = ExtractionSchema.parse(JSON.parse(result.text));
    const original = cleanPhrase(json.phrase ?? "") || parsed.original;
    const language = resolveLanguage(json.targetLang ?? "") ?? parsed.language;
    const source = resolveLanguage(json.sourceLang ?? "") ?? parsed.source;
    log?.info(
      { source: `${result.provider}/${result.model}`, extracted: json },
      "Translation request extracted",
    );
    return {
      ...(original ? { original } : {}),
      ...(language ? { language } : {}),
      ...(source ? { source } : {}),
    };
  } catch (err) {
    log?.warn({ err }, "Translation extraction failed — using the pattern parser");
    return parsed;
  }
}

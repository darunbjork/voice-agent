import { z } from "zod";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../../env.js";
import { generateLlm } from "./llm.call.js";
import { toStrictJsonSchema } from "./gemini.schema.js";
import { extractReminderDetails, type ReminderDetails } from "./reminder-parser.js";
import { normaliseSpokenTimes } from "./spoken-time.js";

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

/** Structured output: what to do and when. */
export const REMINDER_EXTRACT_JSON_SCHEMA = {
  type: "object",
  properties: { task: nullableString, time: nullableString },
  required: ["task", "time"],
} as const;

const REMINDER_EXTRACT_STRICT = toStrictJsonSchema(REMINDER_EXTRACT_JSON_SCHEMA) as object;

const ExtractionSchema = z.object({
  task: z.string().nullable(),
  time: z.string().nullable(),
});

export const REMINDER_EXTRACT_PROMPT = `You extract a reminder from a voice transcript. The transcript comes from speech recognition: numbers may be spoken as words and punctuation may be wrong.
Return JSON with:
- "task": what the user wants to be reminded to do, starting with the verb, without "remind me to" and without the time ("call mom"). null if none is given.
- "time": when, with any clock time written as 24-hour HH:MM ("fourteen thirty" → "14:30", "half past two pm" → "14:30", "quarter to nine" → "08:45", "eighteen hundred" → "18:00") and day words kept ("tomorrow 09:05", "Monday", "Friday 17:00"). null if no time is given. Never guess a time.
Examples:
"Remind me at fourteen thirty to call mom" → {"task":"call mom","time":"14:30"}
"remind me tomorrow at nine oh five to send the invoice" → {"task":"send the invoice","time":"tomorrow 09:05"}
"Remind me to water the plants" → {"task":"water the plants","time":null}`;

/** "14:30" → "at 14:30", "tomorrow 09:05" → "tomorrow at 09:05"; day words kept. */
export function formatReminderTime(raw: string): string | null {
  const t = normaliseSpokenTimes(raw.trim()).replace(/\s+/g, " ");
  if (!t) return null;
  return t.replace(
    /(^|\s)(?<!at\s)(\d{1,2}:\d{2}(?:\s*(?:am|pm))?)\b/i,
    (_m, lead: string, clock: string) => `${lead}at ${clock}`,
  );
}

/**
 * Task and time of a reminder. Live, an LLM extracts them (structured output,
 * validated with Zod); the pattern parser fills any gap and is the whole
 * answer in mock mode or when the LLM is unavailable or returns nonsense.
 */
export async function extractReminder(
  text: string,
  log?: FastifyBaseLogger,
): Promise<ReminderDetails> {
  const parsed = extractReminderDetails(text);
  if (env.VOICE_MOCK) return parsed;

  try {
    const result = await generateLlm(
      {
        system: REMINDER_EXTRACT_PROMPT,
        user: text,
        temperature: 0,
        json: {
          name: "reminder",
          schema: REMINDER_EXTRACT_JSON_SCHEMA,
          strictSchema: REMINDER_EXTRACT_STRICT,
        },
      },
      { log, attemptTimeoutMs: 6_000, hedgeAfterMs: 2_500 },
    );
    const json = ExtractionSchema.parse(JSON.parse(result.text));
    const note = json.task?.trim().replace(/[.!?]+$/, "") || parsed.note;
    const time = (json.time ? formatReminderTime(json.time) : null) ?? parsed.time;
    log?.info(
      { source: `${result.provider}/${result.model}`, extracted: json },
      "Reminder extracted",
    );
    return { note: note || null, time };
  } catch (err) {
    log?.warn({ err }, "Reminder extraction failed — using the pattern parser");
    return parsed;
  }
}

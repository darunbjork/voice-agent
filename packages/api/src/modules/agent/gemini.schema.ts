import { z } from "zod";

export const IntentTypeSchema = z.enum([
  "weather",
  "reminder",
  "translate",
  "summarize",
  "help",
  "general",
  "fallback",
]);

export const WeatherCardSchema = z.object({
  type: z.literal("weather"),
  icon: z.string(),
  temp: z.string(),
  desc: z.string(),
  humidity: z.string(),
  wind: z.string(),
  location: z.string(),
});

export const ReminderCardSchema = z.object({
  type: z.literal("reminder"),
  note: z.string(),
  time: z.string(),
});

export const TranslateCardSchema = z.object({
  type: z.literal("translate"),
  original: z.string(),
  translated: z.string(),
  fromLang: z.string(),
  toLang: z.string(),
});

export const SummaryCardSchema = z.object({
  type: z.literal("summary"),
  points: z.array(z.string()),
  source: z.string(),
});

export const HelpCardSchema = z.object({
  type: z.literal("help"),
  commands: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
    }),
  ),
});

export const ResponseCardSchema = z.discriminatedUnion("type", [
  WeatherCardSchema,
  ReminderCardSchema,
  TranslateCardSchema,
  SummaryCardSchema,
  HelpCardSchema,
]);

export const GeminiAgentOutputSchema = z.object({
  reply: z.string().min(1).max(600),
  intent: IntentTypeSchema,
  card: ResponseCardSchema.nullable(),
});

export type GeminiAgentOutputParsed = z.infer<typeof GeminiAgentOutputSchema>;

const str = { type: "string" } as const;
const card = (type: string, props: Record<string, unknown>) => ({
  type: "object",
  properties: { type: { type: "string", enum: [type] }, ...props },
  required: ["type", ...Object.keys(props)],
});

/**
 * JSON Schema sent to Gemini as `responseJsonSchema` so structured output is
 * constrained to the same shapes the Zod schema accepts. Without it the model
 * invented card types ("translation", "text", "info") and every such reply
 * failed validation.
 */
export const GEMINI_AGENT_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    intent: { type: "string", enum: IntentTypeSchema.options },
    card: {
      anyOf: [
        { type: "null" },
        card("weather", {
          icon: str,
          temp: str,
          desc: str,
          humidity: str,
          wind: str,
          location: str,
        }),
        card("reminder", { note: str, time: str }),
        card("translate", { original: str, translated: str, fromLang: str, toLang: str }),
        card("summary", { points: { type: "array", items: str }, source: str }),
        card("help", {
          commands: {
            type: "array",
            items: {
              type: "object",
              properties: { name: str, description: str },
              required: ["name", "description"],
            },
          },
        }),
      ],
    },
  },
  required: ["reply", "intent", "card"],
} as const;

/** Same schema with every object closed (additionalProperties: false), as strict mode requires. */
export function toStrictJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictJsonSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = toStrictJsonSchema(v);
  if ((schema as { type?: unknown }).type === "object") out.additionalProperties = false;
  return out;
}

/** For OpenAI-compatible strict structured outputs (Groq). */
export const AGENT_RESPONSE_JSON_SCHEMA_STRICT = toStrictJsonSchema(
  GEMINI_AGENT_RESPONSE_JSON_SCHEMA,
) as object;

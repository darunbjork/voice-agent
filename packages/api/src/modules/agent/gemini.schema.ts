import { z } from "zod";

export const IntentTypeSchema = z.enum([
  "weather",
  "reminder",
  "translate",
  "summarize",
  "help",
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

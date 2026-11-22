import { z } from "zod";
import { config } from "dotenv";

config({ path: ["../../.env", ".env"] });

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().url().or(z.string().startsWith("postgresql://")),
  REDIS_URL: z.string().url().or(z.string().startsWith("redis://")).optional(),

  VOICE_MOCK: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  DEEPGRAM_LIVE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  DEEPGRAM_API_KEY: z.string().optional().default(""),
  ELEVENLABS_API_KEY: z.string().optional().default(""),
  // Premade "Lily" — usable on the ElevenLabs free plan (library voices are not).
  ELEVENLABS_VOICE_ID: z.string().min(1).default("pFZP5JQG7iQjIQuC4Bku"),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.1-flash-lite-preview"),
  // Second model raced against GEMINI_MODEL when it is slow or failing (503s and
  // >15 s hangs seen live on the preview model). Empty disables the fallback.
  GEMINI_FALLBACK_MODEL: z.string().default("gemini-3.1-flash-lite"),

  // Non-Google last resort in the LLM chain; skipped when the key is unset.
  // gpt-oss-120b: strongest production text model on Groq, strict json_schema.
  // With the same prompt, gpt-oss-20b still invented facts ("Article 25 GDPR
  // is the right of access"); 120b said it was unsure, at 150–550 ms.
  GROQ_API_KEY: z.string().optional().default(""),
  GROQ_MODEL: z.string().min(1).default("openai/gpt-oss-120b"),

  // nova-3 supports keyterm prompting; nova-2 models fall back to `keywords`.
  DEEPGRAM_MODEL: z.string().min(1).default("nova-3"),
  DEEPGRAM_KEYTERMS: z
    .string()
    .default(
      "ChatGPT,OpenAI,n8n,RAG,MCP,Art25,LLM,TypeScript,React,Node.js,agentic,API,Gemini,Deepgram,ElevenLabs",
    )
    .transform((v) =>
      v
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ),

  // Daily spend caps (UTC day). 0 disables that provider for the day.
  DAILY_MAX_TOKENS: z.coerce.number().int().positive().default(50_000),
  // ElevenLabs characters/day; over the cap TTS is routed to Deepgram Aura.
  DAILY_MAX_TTS_CHARS: z.coerce.number().int().nonnegative().default(650),
  DAILY_MAX_STT_SECONDS: z.coerce.number().int().nonnegative().default(3600),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  ADMIN_PASSWORD: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().min(12).optional(),
  ),

  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().optional(),
  SENTRY_DSN: z.string().optional().default(""),
  // Set by the Fly.io runtime on every machine. Enables the Fly-Client-IP header.
  FLY_APP_NAME: z.string().optional().default(""),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error("❌ Invalid environment variables:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  if (parsed.data.NODE_ENV === "production") {
    if (parsed.data.VOICE_MOCK) {
      console.warn("[env] VOICE_MOCK=true in production — provider calls stay mocked");
    }
    if (parsed.data.DEEPGRAM_LIVE && !parsed.data.DEEPGRAM_API_KEY) {
      console.warn(
        "[env] DEEPGRAM_LIVE=true without DEEPGRAM_API_KEY — speech recognition will fail",
      );
    }
    if (!parsed.data.CORS_ORIGINS || parsed.data.CORS_ORIGINS.length === 0) {
      console.warn("[env] CORS_ORIGINS empty — browser origins will be rejected");
    }
    if (!parsed.data.REDIS_URL) {
      console.warn("[env] REDIS_URL not set — using in-memory usage counters");
    }
  }

  return parsed.data;
}

export const env = loadEnv();

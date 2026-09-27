import { z } from "zod";
import { config } from "dotenv";

config({ path: ["../../.env", ".env"] });

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().url().or(z.string().startsWith("postgresql://")),
  REDIS_URL: z.string().url().or(z.string().startsWith("redis://")),

  VOICE_MOCK: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  DEEPGRAM_API_KEY: z.string().optional().default(""),
  ELEVENLABS_API_KEY: z.string().optional().default(""),
  ELEVENLABS_VOICE_ID: z.string().default("21m00Tcm4TlvDq8ikWAM"),
  GEMINI_API_KEY: z.string().optional().default(""),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  ADMIN_PASSWORD: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().min(12).optional(),
  ),

  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().optional(),
  SENTRY_DSN: z.string().optional().default(""),
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
    if (!parsed.data.CORS_ORIGINS || parsed.data.CORS_ORIGINS.length === 0) {
      console.warn("[env] CORS_ORIGINS empty — browser origins will be rejected");
    }
  }

  return parsed.data;
}

export const env = loadEnv();

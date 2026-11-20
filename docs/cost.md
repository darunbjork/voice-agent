# Cost controls

The public demo (https://voice-agent-nine-self.vercel.app) runs on free provider tiers with no payment card attached. The goal is that it **degrades instead of billing**: when a quota runs out, the app switches to a cheaper path or to text, and never to a paid one.

Local development defaults to `VOICE_MOCK=true`, which makes no provider calls at all. Open-Meteo weather stays live because it is free.

## Providers and free tiers

| Provider   | Used for                     | Model / voice                                                                      | Free-tier notes                                                                                                                                                    |
| ---------- | ---------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deepgram   | Speech-to-text, fallback TTS | `nova-3` + keyterms (STT), `aura-asteria-en` (Aura TTS fallback)                   | Free credit balance; an exhausted balance or rate limit returns `402` / `429`                                                                                      |
| Gemini     | Reasoning                    | `gemini-3.1-flash-lite-preview` (`GEMINI_MODEL`), fallback `gemini-3.1-flash-lite` | Free tier is rate-limited per model; Google rotates preview model ids                                                                                              |
| Groq       | Last-resort LLM (optional)   | `openai/gpt-oss-20b` (`GROQ_MODEL`), skipped without `GROQ_API_KEY`                | Free tier is rate-limited; a `429` counts as budget exhausted, not a circuit-breaker failure                                                                       |
| ElevenLabs | Primary TTS                  | `eleven_turbo_v2_5`, voice Lily (`pFZP5JQG7iQjIQuC4Bku`)                           | Small monthly character quota; library voices return `402`/`404` on the free plan, so a premade voice is used. Exhausted credits come back as `401 quota_exceeded` |

Exact quotas change; check each provider's pricing page before relying on a number:
[Deepgram](https://deepgram.com/pricing) · [Gemini](https://ai.google.dev/pricing) · [ElevenLabs](https://elevenlabs.io/pricing).

## Daily caps

The app keeps its own daily counters (UTC day, in Redis, or in memory when `REDIS_URL` is unset) so it stops before the provider does. Defaults are in [`packages/api/src/env.ts`](../packages/api/src/env.ts).

| Variable                | Default | What is counted                          | Over the cap                                                                                   |
| ----------------------- | ------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `DAILY_MAX_TOKENS`      | 50,000  | Estimated Gemini tokens (chars ÷ 4)      | Turn refused: `429 budget_exceeded` + `Retry-After: 3600` (HTTP), `budget_exceeded` error (WS) |
| `DAILY_MAX_TTS_CHARS`   | 650     | ElevenLabs characters, reserved up front | Reply is spoken by Deepgram Aura instead                                                       |
| `DAILY_MAX_STT_SECONDS` | 3600    | Seconds of live audio sent to Deepgram   | `stt_budget_exhausted`; the client switches to text input (also mid-session)                   |

- The token cap is checked on both the HTTP text route (`costGuard`) and the audio WebSocket, through the same `checkDailyTokenBudget` function.
- At 80% of `DAILY_MAX_TOKENS` a structured-log alert is emitted (and sent to Sentry when `SENTRY_DSN` is set).
- ElevenLabs characters are reserved **before** the request and released again if nothing was synthesised, so a failed call does not use up the cap.

Per-call limits also apply: 500 estimated tokens per Gemini response and 600 characters per TTS reply.

## Fallback chain

```
TTS:  ElevenLabs ──(over char cap · 402 · 429 · quota_exceeded · other failure)──▶ Deepgram Aura ──(fails)──▶ error, text reply only
STT:  Deepgram   ──(over seconds cap · 402 · 429)──▶ text input
LLM:  Gemini     ──(error · circuit open · bad JSON · over budget)──▶ fixed fallback reply
```

- `402` and `429` mean "out of credits / rate-limited", not "provider broken". For ElevenLabs and Deepgram they **do not** count toward the circuit breaker; the app falls back immediately.
- Other provider failures count toward a per-provider circuit breaker, which opens after 5 consecutive failures and probes again after 30 s.
- Aura is only used as a fallback when `DEEPGRAM_API_KEY` is set.

## Changing the caps

The caps are plain environment variables, read at call time.

**Local:** edit `.env` (and `packages/api/.env`), then restart `pnpm turbo dev`.

**Production (Fly.io):**

```bash
fly secrets set DAILY_MAX_TTS_CHARS=1000 DAILY_MAX_STT_SECONDS=1800
```

Setting a secret restarts the machines with the new value. To check today's usage against the caps, sign in to the admin view (or call `GET /api/v1/admin/usage` with the admin credentials).

- `DAILY_MAX_TTS_CHARS=0` turns ElevenLabs off for the day (everything goes to Aura).
- `DAILY_MAX_STT_SECONDS=0` turns live STT off (text input only).
- `DAILY_MAX_TOKENS` must be at least 1; `0` fails env validation and the API will not start.

Keep the caps below the provider's free quota: once the provider itself refuses, the fallbacks still work, but the demo is in degraded mode for the rest of the period.

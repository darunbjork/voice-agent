# Architecture notes

## Process model

One Fastify process holds:

- HTTP routes (health, sessions, agent, admin)
- A WebSocket endpoint (`/api/ws/audio`) that relays PCM to Deepgram
- Prisma client + Redis client
- In-process circuit-breaker state
- Daily usage counters in Redis, mirrored to an in-memory `Map` when Redis is unreachable

Multi-replica deploys need to move circuit-breaker state out of process (the usage counters are already Redis-backed). Recorded as a limitation in `docs/deploy.md`.

## Request paths

### 1. Voice

```
Mic (16 kHz Int16) ─▶ /api/ws/audio ─▶ Deepgram proxy ─▶ transcript_final
                                                              │
                                                              ▼
                                              handleUtterance (brain)
                                                              │
                    ┌─────────────────────────────────────────┤
                    ▼                                         ▼
        agent_response (card + text)                 streamTts (chunks)
                    │                                         │
                    ▼                                         ▼
                 ChatLog                             useTTSPlayer (Web Audio)
```

`agent_response` is sent **before** the Postgres write; `appendTurn` is fire-and-forget so a slow database never adds to perceived latency.

### 2. Text input / quick actions

Identical, except the client sends `{ type: "text_input", text }`, the server synthesizes `transcript_final` from it, and it runs through the same `runAgentTurn` — same brain, same turn index, same persistence, same TTS.

### 3. HTTP text

`POST /api/v1/agent/text` runs `handleUtterance` directly with **no context and no persistence** — no session row, no `appendTurn`. Persistence is WebSocket-only; the HTTP route exists for tests, curl, and non-browser clients.

### 4. Admin

`GET /api/v1/admin/*` — HTTP Basic auth, 60 req/min, `Cache-Control: no-store`. Blank `ADMIN_PASSWORD` → `503` (surface disabled), wrong password → `401`. Read-only on `VoiceSession`, `ConversationTurn`, `DailyUsage`, and circuit snapshots.

## Brain pipeline

```
classifyByKeywords(text)                         ← pure, sync, <5 ms
  ├─ hit  ─▶ runTool(intent, slots)              ← typed ResponseCard
  └─ miss ─▶ safeGenerateAgentOutput(text)       ← one Gemini call, Zod-validated
                        │
                        ▼
                AgentReply { text, intent, card, latencyMs }
                        │
                        ▼
                sendSafe({ type: "agent_response" })   ← BEFORE persist
                        │
                        ▼
                appendTurn (Postgres, fire-and-forget)
                        │
                        ▼
                streamTts → tts_chunk → tts_done
```

Context: the WebSocket path loads the last `CONTEXT_TURNS = 3` completed turns (`session.service.ts`) and prepends them to the slow-path prompt only. The fast path never pays for context.

## Failure modes

| Failure                       | Behaviour                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider 5 consecutive errors | Circuit opens, spoken fallback, no network call                                                                                                                              |
| Gemini returns malformed JSON | Zod rejects, `fallback` intent, spoken apology                                                                                                                               |
| Budget exceeded (per-call)    | `BudgetExceededError`, spoken fallback                                                                                                                                       |
| Daily ceiling hit             | `POST /api/v1/agent/text` returns `429` (`costGuard`). **WS turns are not gated on the ceiling yet** — the 80% alert and `/health.dailyTokens` are the only guardrails there |
| Redis unreachable             | Usage falls back to the in-memory `Map`, health shows `redis: "down"`                                                                                                        |
| Postgres unreachable          | Health shows `db: "down"`, WS turns fail to persist but still answer                                                                                                         |
| Barge-in                      | Client stops every active audio source + sends `{ type: "barge_in" }`, server cancels the TTS stream                                                                         |
| WebSocket drop                | Client reconnects with exponential backoff, max 3 attempts, base delay 500 ms                                                                                                |
| Late `tts_chunk` after cancel | `cancelledRef` drops every subsequent `enqueue` — no zombie playback                                                                                                         |

## Type contracts

All shared types live in `@voice-agent/shared-types`.

- `ClientAudioMessage` — browser → server (discriminated union on `type`)
- `ServerAudioMessage` — server → browser (discriminated union)
- `AgentReply` — full turn result with `latencyMs: LatencyBreakdown`
- `ResponseCard` — discriminated union of 5 card types
- `IntentType` — `weather | reminder | translate | summarize | help | fallback`

Any shape crossing the wire is one of these. No `unknown` in route handlers, no `any` anywhere in hand-written `src/`.

## File layout

```
packages/api/src/
  app.ts                 buildApp + plugin registration (order locked)
  env.ts                 Zod-validated env, fail-fast; loads ../../.env then .env
  sentry.ts              optional Sentry init (disabled without SENTRY_DSN)
  modules/
    audio/               WS endpoint, Deepgram proxy, ElevenLabs service
    agent/               intent classifier, Gemini service, tools, pipeline
    session/             Prisma persistence, context window
    admin/               read-only ops endpoints
    health/              /health with dep + circuit snapshots
  plugins/               Prisma client, Redis client (fastify-plugin)
  middleware/            correlation-id, cost-guard, basic-auth
  utils/                 token-budget, usage-tracker, circuit-breaker, voice-mock
  config/                cors
  __tests__/             vitest (17 files, 73 tests)
  generated/prisma/      Prisma client (gitignored)
```

The server auto-starts from `app.ts` only when `NODE_ENV !== "test"` (ISSUE-006) — there is no separate `server.ts`.

## Env loading order

1. `packages/api/src/env.ts` runs `dotenv.config({ path: ["../../.env", ".env"] })`
   — root first, `packages/api/.env` second as a local override.
2. `turbo.json` `globalEnv` passes those names through to every `pnpm turbo` child.
3. Prisma CLI reads `packages/api/.env` only (no path option). Hence the duplicated `DATABASE_URL`.

Both files must carry the same `DATABASE_URL`, or migrations and the app will hit different databases.

## Plugin order (locked)

`helmet → cors → cookie → csrf → rate-limit → websocket → swagger → swagger-ui → prisma → redis`, then the `correlationId` `onRequest` hook, then route plugins (`health → agent → audio → session → admin`). Reordering breaks either the Swagger schemas or the decorator visibility rules (see ISSUE-007 in `docs/issues-and-solutions.md`).

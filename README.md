# Voice Agent

[![CI](https://github.com/darunbjork/voice-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/darunbjork/voice-agent/actions/workflows/ci.yml)

**Live demo:** https://voice-agent-nine-self.vercel.app

Production-style voice agent: real-time streaming STT, structured LLM reasoning, streaming TTS, cost controls, and an Obsidian Forge UI.

**Built with Deepgram · Gemini · ElevenLabs**

> Local default is `VOICE_MOCK=true` — zero provider spend until you opt in. The public demo runs live providers on free tiers (see below).

## Live demo

- **Web** — https://voice-agent-nine-self.vercel.app (target: `https://voice-agent.darun.dev`)
- **API health** — https://darun-voice-agent-api.fly.dev/health
- **Portfolio** — [darun-dev.pages.dev](https://darun-dev.pages.dev)

## Architecture

```
┌─────────────┐  PCM 16kHz   ┌───────────────────────────────────────┐
│  Browser    │─────────────▶│  Fastify API                          │
│  Mic / UI   │  WS /api/ws  │  • Deepgram proxy (STT)               │
│             │◀─────────────│  • Intent (keywords → Gemini Flash)   │
│  TTS play   │  tts_chunk   │  • Tools (weather, reminder, …)       │
│  Cards      │  agent_*     │  • ElevenLabs stream (TTS)            │
│  Admin      │  REST /api   │  • Sessions · usage · circuit breaker │
└─────────────┘              └───────────┬───────────────────────────┘
                                         │
                             ┌───────────▼───────────┐
                             │  Postgres · Redis     │
                             └───────────────────────┘
```

## Latency budget

| Path                             | Mock (measured in-app per turn) | Live (estimated — not measured on prod) |
| -------------------------------- | ------------------------------- | --------------------------------------- |
| Keyword intent classify          | < 5 ms                          | < 5 ms                                  |
| Full brain pipeline              | < 50 ms                         | 300–800 ms                              |
| Voice final → first TTS chunk    | < 150 ms                        | 400–900 ms                              |
| Barge-in to silence              | < 200 ms                        | < 200 ms                                |
| Total turn (green HUD threshold) | < 500 ms                        | 800–1500 ms                             |

The mock column is what the LatencyHUD reports on a local run; the live column is the design target — **no production measurement exists yet**, and the HUD is the instrument that will produce one. Thresholds are `green < 500 ms`, `amber < 1000 ms`, `red ≥ 1000 ms`.

## Free-tier demo

The public demo runs on free provider tiers with no card attached, so when a quota runs out it degrades to a cheaper path instead of billing.

**Pipeline:** Deepgram `nova-2` (STT) → Gemini `gemini-3.1-flash-lite-preview` (overridable via `GEMINI_MODEL`) → ElevenLabs `eleven_turbo_v2_5`, voice **Lily** (premade).

**Daily caps** (UTC day; defaults, all env-configurable), enforced on both the HTTP text route and the audio WebSocket:

| Variable                | Default | Over the cap                                                               |
| ----------------------- | ------- | -------------------------------------------------------------------------- |
| `DAILY_MAX_TOKENS`      | 50,000  | Gemini turn refused: `429 budget_exceeded` (HTTP) / `budget_exceeded` (WS) |
| `DAILY_MAX_TTS_CHARS`   | 650     | TTS routed to Deepgram Aura                                                |
| `DAILY_MAX_STT_SECONDS` | 3600    | `stt_budget_exhausted`, client falls back to text input                    |

A structured-log alert fires at 80% of `DAILY_MAX_TOKENS` (and a Sentry warning when `SENTRY_DSN` is set).

**Where the counters live.** With `REDIS_URL` set, every daily counter (tokens, TTS characters, STT seconds) and the once-a-day 80% alert are stored in Redis: they survive restarts and are shared by every machine. **Without Redis the caps are per machine run** — each machine counts on its own, and a restart (Fly stops idle machines) starts the day again at zero. If Redis becomes unreachable, the app falls back to in-memory counters and logs `usage_redis_fallback`. Circuit breakers and HTTP rate limits are always per machine.

**Fallbacks:**

- ElevenLabs over the character cap, or returning `402` / `429` / `quota_exceeded` → Deepgram Aura voice
- Deepgram STT over the seconds cap, or refused (`402` / `429`) → text input
- Gemini failure (error, circuit open, unparseable output, over budget) → a fixed fallback reply
- `402` / `429` mean "budget exhausted", not "provider broken": they skip the circuit breaker and fall back immediately

Also: circuit breaker per provider (opens after 5 consecutive failures), per-call pre-flight token/character budgets, and all provider keys server-side only. Details and runbook in [`docs/cost.md`](docs/cost.md).

## Monorepo

```
packages/
  api/           Fastify 5 · Prisma · WebSocket · agent · admin
  web/           React 19 · Vite · voice UI + admin
  shared-types/  Discriminated unions (audio, agent, cards)
```

## Quick start

```bash
# 1. Install
pnpm install

# 2. Configure env — TWO files (see "Why two .env files" below)
cp .env.example .env
cp .env packages/api/.env

# 3. Edit .env and set a JWT_SECRET and ADMIN_PASSWORD
#    openssl rand -hex 32   for each

# 4. Bring up Postgres and Redis
docker compose up -d

# 5. Run migrations
pnpm --filter @voice-agent/api exec prisma migrate dev

# 6. Start everything
pnpm turbo dev
```

- **Web:** http://localhost:5173
- **API health:** http://localhost:3001/health
- **Swagger:** http://localhost:3001/docs
- **Admin:** click **Admin** in the app header. Sign in with `ADMIN_PASSWORD`.

`.env.example` already points at the compose ports (Postgres `5434`, Redis `6380`) — copy it as-is and it works.

### Why two `.env` files

- The Fastify app loads `../../.env` then `.env` (root-first).
- Prisma CLI reads only `packages/api/.env`.
- Both must contain the same `DATABASE_URL`.

Full explanation in [`docs/architecture.md`](docs/architecture.md).

### Admin sign-in

`ADMIN_PASSWORD` gates every `/api/v1/admin/*` route (HTTP Basic, 60 req/min, `Cache-Control: no-store`):

- **blank** → `503` — the admin surface is disabled on purpose in a fresh clone.
- **set, wrong password** → `401 {"error":"unauthorized"}`.
- **set, correct password** → read-only sessions / turns / usage / circuits.

Local dev without admin: leave it blank. To try it: set it, restart `pnpm turbo dev`, then sign in with that value.

## Configuration

All variables are validated with Zod in [`packages/api/src/env.ts`](packages/api/src/env.ts). Names and defaults only — never commit values.

| Variable                | Default                         | Notes                                                                              |
| ----------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `PORT`                  | `3001`                          |                                                                                    |
| `NODE_ENV`              | `development`                   | `development` · `test` · `production`                                              |
| `DATABASE_URL`          | —                               | required                                                                           |
| `REDIS_URL`             | —                               | optional; without it the daily caps are per machine run                            |
| `VOICE_MOCK`            | `true`                          | `false` calls real providers                                                       |
| `DEEPGRAM_LIVE`         | `false`                         | real STT while the rest stays mocked                                               |
| `DEEPGRAM_API_KEY`      | —                               | secret                                                                             |
| `ELEVENLABS_API_KEY`    | —                               | secret                                                                             |
| `ELEVENLABS_VOICE_ID`   | `pFZP5JQG7iQjIQuC4Bku`          | premade "Lily", usable on the ElevenLabs free plan                                 |
| `GEMINI_API_KEY`        | —                               | secret                                                                             |
| `GEMINI_MODEL`          | `gemini-3.1-flash-lite-preview` |                                                                                    |
| `DAILY_MAX_TOKENS`      | `50000`                         | must be ≥ 1                                                                        |
| `DAILY_MAX_TTS_CHARS`   | `650`                           | `0` disables ElevenLabs for the day                                                |
| `DAILY_MAX_STT_SECONDS` | `3600`                          | `0` disables live STT for the day                                                  |
| `JWT_SECRET`            | —                               | required, ≥ 32 chars                                                               |
| `JWT_EXPIRES_IN`        | `7d`                            |                                                                                    |
| `ADMIN_PASSWORD`        | —                               | optional, ≥ 12 chars; blank disables admin                                         |
| `FRONTEND_URL`          | `http://localhost:5173`         |                                                                                    |
| `CORS_ORIGINS`          | —                               | comma-separated allowlist for production                                           |
| `SENTRY_DSN`            | —                               | optional; set as a Fly secret to report HTTP 500s and failed voice turns to Sentry |

## Stack

| Layer  | Choice                                                              |
| ------ | ------------------------------------------------------------------- |
| API    | Fastify 5, TypeScript strict, Zod env validation                    |
| STT    | Deepgram Nova-2 (WebSocket proxy)                                   |
| LLM    | Gemini Flash[^gemini], structured JSON + Zod, single slow-path call |
| TTS    | ElevenLabs Turbo v2.5, PCM 16 kHz stream                            |
| Data   | PostgreSQL + Prisma 6, Redis 7                                      |
| Web    | React 19, Vite 6, GSAP 3, CSS design tokens (Obsidian Forge)        |
| Deploy | Fly.io (API), Vercel (web), Neon (Postgres), Upstash (Redis)        |

[^gemini]: The pinned id is `gemini-3.1-flash-lite-preview` (`GEMINI_MODEL_ID` in `packages/api/src/modules/agent/gemini.tools.ts`), overridable with the `GEMINI_MODEL` env var. On the free tier `gemini-flash-latest` timed out at 45 s while flash-lite-preview answered in ~1.6 s. Google rotates model ids — if it 404s, set `GEMINI_MODEL` to the current Flash id.

## Scripts

```bash
pnpm turbo type-check    # 0 errors across all packages
pnpm turbo test          # vitest, VOICE_MOCK enforced
pnpm turbo build         # tsc + vite build
pnpm format              # prettier
pnpm format:check        # CI-equivalent
```

## Docs

- [`docs/architecture.md`](docs/architecture.md) — request paths, failure modes, type contracts
- [`docs/cost.md`](docs/cost.md) — provider caps and runbook
- [`docs/security.md`](docs/security.md) — threat model and checklist
- [`docs/deploy.md`](docs/deploy.md) — Fly + Vercel walkthrough
- [`docs/demo.md`](docs/demo.md) — recruiter demo script
- [`docs/mock-mode-tool-limitations.md`](docs/mock-mode-tool-limitations.md) — mock-mode behavior and tool limitations
- [`docs/portfolio.md`](docs/portfolio.md) — project card + repo copy for darun.dev
- [`docs/issues-and-solutions.md`](docs/issues-and-solutions.md) — defect log with stable IDs

## Deployment

- **API — Fly.io**, deployed manually with `fly deploy` (config in [`fly.toml`](fly.toml)). The `release_command` runs `prisma migrate deploy` before the new release goes live. Secrets (provider keys, `DATABASE_URL`, `JWT_SECRET`, `ADMIN_PASSWORD`, …) are set with `fly secrets set` / `fly secrets import`, never in `fly.toml`.
- **Web — Vercel.**

More detail in [`docs/deploy.md`](docs/deploy.md).

## Author

**Darun Mustafa** · [GitHub](https://github.com/darunbjork) · [Portfolio](https://darun-dev.pages.dev)

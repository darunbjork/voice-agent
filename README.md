# Voice Agent

Production-style voice agent: real-time streaming STT, structured LLM reasoning, streaming TTS, cost controls, and an Obsidian Forge UI.

**Built with Deepgram · Gemini · ElevenLabs**

> Default `VOICE_MOCK=true` — zero provider spend until you opt in.

## Live demo

- **Web** — `<web URL after Vercel deploy>` (target: `https://voice-agent.darun.dev`)
- **API health** — `<fly URL>/health` (target: `https://voice-agent-api.fly.dev/health`)
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

## Cost controls

- Provider caps set and documented in [`docs/cost.md`](docs/cost.md)
- Daily token ceiling (50,000): `429` on the HTTP text route, 80% alert via structured log
- Circuit breaker per provider (opens after 5 consecutive failures)
- Pre-flight character/token budget before every Gemini or ElevenLabs call
- All provider keys server-side only — see [`docs/security.md`](docs/security.md)

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

[^gemini]: The pinned id is `MODEL_ID = "gemini-1.5-flash"` in `packages/api/src/modules/agent/gemini.service.ts`. Google rotates model ids — if it 404s, bump that constant to the current Flash id. Docs say "Gemini Flash" on purpose.

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
- [`docs/portfolio.md`](docs/portfolio.md) — project card + repo copy for darun.dev
- [`docs/issues-and-solutions.md`](docs/issues-and-solutions.md) — defect log with stable IDs

## Deploy

See [`docs/deploy.md`](docs/deploy.md).

## Author

**Darun Mustafa** · [GitHub](https://github.com/darunbjork) · [Portfolio](https://darun-dev.pages.dev)

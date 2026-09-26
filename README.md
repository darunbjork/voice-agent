# Voice Agent

A production-style voice agent monorepo: Fastify API, React frontend, shared type contracts, cost-controlled LLM/STT/TTS paths. Currently on the mock path — `VOICE_MOCK=true` means **zero provider calls** (see [docs/cost.md](docs/cost.md) before changing that).

## Stack

- **pnpm + Turborepo** workspace, TypeScript everywhere (`strict`)
- **Fastify 5** API with Swagger UI at `/docs`
- **Prisma 6** + PostgreSQL (session persistence)
- **Redis** (daily usage counters, atomic `MULTI`/`EXEC`)
- **Vite** frontend (`packages/web`)
- **Vitest** tests, **GitHub Actions** CI (Lint → Type-check → Test → Build)

## Repo layout

```
packages/shared-types  @voice-agent/shared-types  single source of truth for cross-wire types
packages/api           @voice-agent/api           Fastify server (port 3001)
packages/web           @voice-agent/web           Vite frontend (port 5173)
docs/                  day logs, cost model, issues & solutions
```

## Prerequisites

- Node.js 22+ (CI runs 22)
- pnpm 9.15.0 — installed automatically via the `packageManager` field if you have corepack enabled (`corepack enable`)
- Docker with Compose v2

## Getting started

```bash
# 1. Install dependencies
pnpm install

# 2. Environment — copy the template and fill in values
cp .env.example .env
#    IMPORTANT: docker-compose publishes Postgres on host port 5434 and Redis
#    on 6380 (see Ports below). Make sure .env matches:
#    DATABASE_URL=postgresql://voiceagent:voiceagent@localhost:5434/voiceagent
#    REDIS_URL=redis://localhost:6380

# 3. Start Postgres + Redis
docker compose up -d
docker compose ps          # both containers should be healthy

# 4. Prisma: the CLI reads .env from packages/api/ (not the repo root),
#    so hand it the DATABASE_URL it needs, then migrate + generate
cd packages/api
echo "DATABASE_URL=$(grep '^DATABASE_URL=' ../../.env | cut -d= -f2-)" > .env   # gitignored
pnpm exec prisma migrate dev --name init
pnpm exec prisma generate
cd ../..

# 5. Run everything (api :3001, web :5173)
pnpm dev
```

API only:

```bash
pnpm --filter @voice-agent/api dev
```

> `packages/api/.env` and `packages/api/src/generated/prisma/` are generated
> artifacts — both are gitignored. Never commit them, never put real secrets in
> the repo.

## Scripts (run from the repo root)

| Command           | What it does                                       |
| ----------------- | -------------------------------------------------- |
| `pnpm dev`        | Run all packages in watch mode                     |
| `pnpm build`      | Build all packages (`tsc`, Vite)                   |
| `pnpm type-check` | `tsc --noEmit` across the workspace                |
| `pnpm lint`       | Lint all packages (placeholder until ESLint lands) |
| `pnpm test`       | Run Vitest suites                                  |
| `pnpm clean`      | Remove build output                                |

## Ports

| Service                     | Port        |
| --------------------------- | ----------- |
| API                         | 3001        |
| Frontend                    | 5173        |
| Postgres (host → container) | 5434 → 5432 |
| Redis (host → container)    | 6380 → 6379 |

## Verify your setup

```bash
# Health: expect status/db/redis all "ok"
curl -s localhost:3001/health | jq

# Swagger UI
open http://localhost:3001/docs

# Tests + types
pnpm test && pnpm type-check
```

Housekeeping checks (must all be empty — see [AGENTS.md](AGENTS.md)):

```bash
grep -rn ": any\|<any>\|as any" packages/api/src/ --exclude-dir=generated
grep -rn "@fastify/pino\|pino-http" packages/api/src/ packages/api/package.json
grep -rn "await import(" packages/api/src/ --exclude-dir=generated
```

## Cost & safety

- `VOICE_MOCK=true` (the default) = **zero network calls to Deepgram / ElevenLabs / Gemini**. Leave it that way until [docs/cost.md](docs/cost.md) caps are in place and you have consciously accepted the spend.
- Every paid-path function must run `assertWithinBudget(...)` before any network call.
- `.env` is gitignored — never commit it, never print secrets.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs four jobs on pushes to `main` and on PRs:

```
Lint (parallel) → Type-check → Test (Postgres + Redis services) → Build
```

The pnpm version comes from the `packageManager` field in the root
`package.json` — do not also pin `version:` in `pnpm/action-setup` (the action
errors on both being present).

## Docs

- [AGENTS.md](AGENTS.md) — binding rules for AI-assisted sessions
- [docs/cost.md](docs/cost.md) — budgets, caps, and the mock-path contract
- [docs/issues-and-solutions.md](docs/issues-and-solutions.md) — ISSUE-001…, the log of every trap hit so far; check the Index before writing code

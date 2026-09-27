# AGENTS.md — voice-agent monorepo

Loaded automatically at the start of every opencode session. Read it before writing code. Companion file: `docs/issues-and-solutions.md` (ISSUE-001 … ISSUE-015) — the binding constraints live there; check the Index table first.

## Repo layout

```
packages/shared-types  @voice-agent/shared-types  single source of truth for every cross-wire type
packages/api           @voice-agent/api           Fastify 5 server (port 3001)
packages/web           @voice-agent/web           Vite frontend (port 5173)
docs/                  architecture, cost model, deploy, demo, issues & solutions
```

Workspace is pnpm + Turborepo. `turbo.json` locks `dependsOn: ["^build"]` — shared-types always builds before its consumers.

## Non-negotiable rules

- **RULE 1 — No `any`.** Never in src, never as a "temporary" cast on `card`, `reply`, or any contract field. Use the full discriminated union from `@voice-agent/shared-types`.
- **RULE 2 — `.js` extension on every relative import** (`./env.js`, `../../env.js`). `module: NodeNext` requires it; missing extensions are the #1 cause of "Cannot find module" once you run `dist/` instead of `tsx`.
- **RULE 3 — Fastify only.** `app.register()` and `app.addHook()` — never Express-style `app.use()`. Plugin registration order in `app.ts` is locked; do not reorder.
- **RULE 8 — Complete JSON Schema on every route.** Every route declares its full response schema. No schema-less handlers.
- **RULE 9 — Zod-validated env only.** All configuration flows through `packages/api/src/env.ts`. Never read `process.env` in a route or module; never bypass the schema.

## House rules

- No `any`, no non-narrowing casts (`as unknown as T`). Narrowing casts of `request.body` must go through a **named interface** declared above the handler (`TextAgentBody`), not an inline `as { … }`.
- Explicit return type on every async function.
- No placeholder comments: no `// ...`, no `// TODO` unless it names an issue (`// TODO(ISSUE-015): …`), no elided code in delivered files.
- Route plugins are imported statically at the top of `app.ts`. No `await import()` in the boot path without a documented circular dependency.
- Banned symbols in `packages/api/src/` and `packages/api/package.json`: `@fastify/pino`, `pino-http`, `fastify-type-provider-zod`, `allowList`, `sessionPlugin`. See ISSUE-001/002/004/005.
- `app.ts` keeps the `NODE_ENV !== "test"` guard around `start()` (ISSUE-006). No `app.decorate("config", env)` (ISSUE-007).
- Never install or import a package before checking it exists on the npm registry — 404s have already cost one session.

## Safety

- `VOICE_MOCK=true` in `.env` means **zero provider calls**. Never set it to `false`, never add code that talks to Deepgram / ElevenLabs / Gemini until `docs/cost.md` caps exist and the plan says so.
- Every paid-path function runs `assertWithinBudget(...)` before the network call.
- `.env` is gitignored — never commit it, never print secrets.

## Verification (run before you claim done)

```bash
pnpm turbo type-check                      # must be 0 errors
grep -rn ": any\|<any>\|as any" packages/api/src/        # empty
grep -rn "from \"\\./\|from \"\\.\\./" packages/api/src/ | grep -v "\.js\""   # empty
grep -rn "@fastify/pino\|pino-http\|fastify-type-provider-zod\|allowList\|sessionPlugin" packages/api/src/ packages/api/package.json   # exit 1
```

Health check: `curl -s localhost:3001/health` (`status`, `db`, `redis`, `voiceMock`, `dailyTokens`, `circuits`, …), `curl -s localhost:3001/docs` (Swagger UI).

## Git

- `main` is protected: direct pushes are rejected, PRs are squash-merged with linear history.
- One branch per change: `feat/<slug>` (e.g. `feat/ship-docs`). The squash commit subject uses conventional format with no numbering (`feat(api): …`).
- The human runs the git/PR commands unless explicitly told otherwise.

## Session protocol

1. On start, read this file and `docs/issues-and-solutions.md`; be able to name every ISSUE before writing code.
2. If a constraint in the issues log conflicts with a pasted plan, the **issues log wins** — cite the ISSUE id when correcting course.
3. Deliver complete files, no placeholders. Show command output, don't summarize it. Stop and wait when told.

# Issues & Solutions

Every issue is tagged with the day it was hit. Constraints are binding for every later day — do not reintroduce a banned pattern.

## Index

| Issue                                                                                     | Day        | Title                                                            |
| ----------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------- |
| [ISSUE-001](#issue-001--fastifypino-does-not-exist)                                       | **Day 3**  | `@fastify/pino` does not exist                                   |
| [ISSUE-002](#issue-002--fastify-type-provider-zod-imported-but-not-installed)             | **Day 3**  | `fastify-type-provider-zod` imported but not installed           |
| [ISSUE-003](#issue-003--root-env-not-found-when-cwd-is-packagesapi)                       | **Day 3**  | root `.env` not found when cwd is `packages/api`                 |
| [ISSUE-004](#issue-004--explicit-sessionplugin-on-csrf-registration)                      | **Day 3**  | explicit `sessionPlugin` on CSRF registration                    |
| [ISSUE-005](#issue-005--allowlist-on-rate-limit-hides-localhost)                          | **Day 3**  | `allowList` on rate-limit hides localhost                        |
| [ISSUE-006](#issue-006--server-must-not-auto-start-under-test)                            | **Day 3**  | server must not auto-start under test                            |
| [ISSUE-007](#issue-007--no-appdecorateconfig-env-day-6-scope)                             | **Day 3**  | no `app.decorate("config", env)` (Day 6 scope)                   |
| [ISSUE-009](#issue-009--geminiagentoutput-missing-from-shared-types)                      | **Day 4**  | `GeminiAgentOutput` missing from shared-types                    |
| [ISSUE-010](#issue-010--inline-as----on-requestbody)                                      | **Day 4**  | Inline `as { ... }` on `request.body`                            |
| [ISSUE-011](#issue-011--dynamic-await-import-inside-fastify-register)                     | **Day 4**  | Dynamic `await import()` inside Fastify register                 |
| [ISSUE-012](#issue-012--usage-tracker-read-modify-write-race)                             | **Day 4**  | usage-tracker read-modify-write race                             |
| [ISSUE-013](#issue-013--additionalproperties-true-on-reply-response-schema)               | **Day 4**  | `additionalProperties: true` on reply response schema            |
| [ISSUE-014](#issue-014--custom-error-handler-returned-500-for-schema-validation-failures) | **Day 4**  | Custom error handler returned 500 for schema validation failures |
| [ISSUE-015](#issue-015--ws-path-ignores-the-daily-token-ceiling)                          | **Day 30** | WS path ignores the daily token ceiling                          |

---

## Day 3 — Fastify bootstrap (`packages/api`)

### ISSUE-001 — `@fastify/pino` does not exist

**Day:** 3 · Fastify bootstrap (`packages/api`)

**Symptom:** `pnpm add @fastify/pino` → `ERR_PNPM_FETCH_404` / `GET https://registry.npmjs.org/@fastify%2Fpino: Not Found`. Same for `fastify-pino`.

**Cause:** Fastify 5 ships Pino built in (`Fastify({ logger: {...} })`); there is no official pino plugin package on npm.

**Solution:** Configure logging on the factory — no plugin import:

```ts
logger:
  env.NODE_ENV === "development"
    ? { level: "debug", transport: { target: "pino-pretty", options: { colorize: true } } }
    : { level: env.NODE_ENV === "production" ? "info" : "debug" },
```

`pino-pretty` stays a devDependency. **Rule:** never install or import `@fastify/pino` or `pino-http`.

---

### ISSUE-002 — `fastify-type-provider-zod` imported but not installed

**Day:** 3 · Fastify bootstrap (`packages/api`)

**Symptom:** TS2307 `Cannot find module 'fastify-type-provider-zod'` in `health.routes.ts`, from a copy-pasted comment-level import.

**Solution:** Delete the import. Day 3 routes use pure JSON Schema; the Zod type-provider lands only when we actually adopt it. **Rule:** never import `fastify-type-provider-zod` until a day that installs it.

---

### ISSUE-003 — root `.env` not found when cwd is `packages/api`

**Day:** 3 · Fastify bootstrap (`packages/api`)

**Symptom:** `dotenv.config()` loads nothing under `pnpm --filter @voice-agent/api dev` (cwd = `packages/api`), so Zod rejects `DATABASE_URL` / `JWT_SECRET` and the process exits.

**Solution:** one call with an ordered path list:

```ts
config({ path: ["../../.env", ".env"] });
```

Verified with dotenv 18: root `.env` loads (13 vars), `packages/api/.env` used as fallback, real process env always overrides files. **Rule:** `env.ts` must use exactly this call — no `fileURLToPath` / `import.meta.url` variants.

---

### ISSUE-004 — explicit `sessionPlugin` on CSRF registration

**Day:** 3 · Fastify bootstrap (`packages/api`)

**Symptom:** `@fastify/csrf-protection` registered with `sessionPlugin: "@fastify/cookie"` — redundant and trips the banned-pattern check.

**Solution:** omit it. The package default is already `'@fastify/cookie'` (`node_modules/@fastify/csrf-protection/index.js:17`), and `@fastify/cookie` is registered immediately before it. **Rule:** CSRF options are `{ cookieOpts: { signed: true } }` only.

---

### ISSUE-005 — `allowList` on rate-limit hides localhost

**Day:** 3 · Fastify bootstrap (`packages/api`)

**Symptom:** `allowList: ["127.0.0.1"]` disables rate limiting for local traffic — masks the limiter in dev and trips the banned-pattern check.

**Solution:** register with `max` + `timeWindow` only:

```ts
await app.register(fastifyRateLimit, { max: 200, timeWindow: "1 minute" });
```

**Rule:** no `allowList` anywhere.

---

### ISSUE-006 — server must not auto-start under test

**Day:** 3 · Fastify bootstrap (`packages/api`)

**Symptom:** importing `buildApp()` in a test also binds port 3001 → `EADDRINUSE` / dangling handles.

**Solution:** guard the entrypoint:

```ts
if (process.env.NODE_ENV !== "test") {
  void start();
}
```

**Rule:** `app.ts` keeps this guard forever; tests import `buildApp` and call `app.inject()`.

---

### ISSUE-007 — no `app.decorate("config", env)` (Day 6 scope)

**Day:** 3 · Fastify bootstrap (`packages/api`)

**Symptom:** decorating the Fastify instance with the env object couples every route to a global mutable surface before the config layer exists.

**Solution:** do nothing — modules import `env` from `../env.js` directly. The decorator pattern is explicitly deferred to Day 6. **Rule:** no `app.decorate("config", …)` until Day 6 says so.

---

## Day 4 — Cost controls (`packages/api` + `docs/cost.md`)

### ISSUE-009 — `GeminiAgentOutput` missing from shared-types

**Day:** 4 · Cost controls
**Status:** FIXED (Day 4)
**Discovered:** Day 4 plan review
**Symptom:** `TS2305: Module '"@voice-agent/shared-types"' has no
exported member 'GeminiAgentOutput'` in `voice-mock.ts`.
**Root cause:** The bootcamp spec listed `AgentReply` and
`LatencyBreakdown` but not the literal Gemini output contract.
**Resolution:** Added `GeminiAgentOutput = { reply; intent; card }`
to `packages/shared-types/src/agent.types.ts` and re-exported it.
This is the locked contract the real Gemini call must satisfy on
Day 16.
**Do not** re-introduce a local type for this shape.

---

### ISSUE-010 — Inline `as { ... }` on `request.body`

**Day:** 4 · Cost controls
**Status:** FIXED (Day 4)
**Symptom:** Readability + uniformity. AGENTS.md asks for explicit
interfaces over inline shapes.
**Resolution:** Every route defines a named interface for its body
(`TextAgentBody`, `TextAgentResponse`, `HealthResponse`). Cast once
via `app.post<{ Body: T }>(...)`. No inline `as { a: T; b: T }`.
**Enforcement:** `grep -rn "as {" packages/api/src/` must return
empty on every day going forward.

---

### ISSUE-011 — Dynamic `await import()` inside Fastify register

**Day:** 4 · Cost controls
**Status:** FIXED (Day 4)
**Symptom:** Boot path had an unnecessary await point between plugin
registration and route registration.
**Root cause:** Draft used `const { agentRoutes } = await import(...)`
for no documented circular-dependency reason.
**Resolution:** Static top-level imports in `app.ts`. No
`await import()` in the boot path.
**Enforcement:** `grep -rn "await import(" packages/api/src/` must
return empty on every day going forward.

---

### ISSUE-012 — usage-tracker read-modify-write race

**Day:** 4 · Cost controls
**Status:** FIXED for Day 4 (in-memory). REDESIGN on Day 5.
**Symptom:** Concurrent POSTs to `/api/v1/agent/text` can lose token
increments because `await getDailyUsage()` yielded control between
read and write.
**Day 4 fix:** `incrementUsage` is **synchronous**. No awaits between
read and write. Tested with two sequential POSTs; `dailyTokens`
reflects both.
**Day 5 fix:** Replace the in-memory `Map` with Redis `INCRBY`
(atomic, cross-replica, TTL-scoped by date). File as **ISSUE-012b**
when it lands.

---

### ISSUE-013 — `additionalProperties: true` on reply response schema

**Day:** 4 · Cost controls
**Status:** OPEN — Day 16 cleanup
**Blocks:** nothing today (mock-only endpoint)
**Planned:** When the real Gemini path lands (Day 16), the response
schema gets the full `AgentReply` shape so Fastify's fast serializer
is used. Today's mock keeps the loose schema on purpose — locking a
shape we haven't finalized would be premature.
**Tracking:** revisit on Day 16 PR.

---

### ISSUE-014 — Custom error handler returned 500 for schema validation failures

**Day:** 4 · Cost controls
**Status:** FIXED (Day 4)
**Symptom:** `POST /api/v1/agent/text` with a body missing `text`
returned **500 internal** instead of **400**.
**Root cause:** The custom `app.setErrorHandler` from the Day 4 plan
replaced Fastify's default handler, which is what maps
`error.validation` (FST_ERR_VALIDATION) to status 400. The fallback
branch sent 500 for every non-budget error.
**Resolution:** The handler now checks `err.validation !== undefined`
first and responds 400 `{ error: "validation_error", message,
correlationId }`. The handler is typed `setErrorHandler<FastifyError>`
because Fastify 5 defaults the error parameter to `unknown`.
**Enforcement:** any new route with a body schema must return 400 on
an invalid payload — a 500 means this branch was lost.

---

## Day 30 — Ship

### ISSUE-015 — WS path ignores the daily token ceiling

**Day:** 30 · Ship
**Status:** OPEN — post-Day-30 fix (~15 min)
**Symptom:** With `VOICE_MOCK=false`, WebSocket turns keep calling
Gemini and ElevenLabs after `DAILY_MAX_TOKENS` (50,000) is reached.
Only `POST /api/v1/agent/text` returns `429`. The primary path —
voice — has no daily gate at all, so the ceiling is advisory there.
**Root cause:** `costGuard` (`middleware/cost.guard.ts`) is registered
only as the `preHandler` of `agent.routes.ts`. `runAgentTurn` in
`modules/audio/audio.routes.ts` calls `handleUtterance` with no usage
check, and `assertDailyBudget` in `utils/token-budget.ts` is referenced
by nothing but its own test. Per-operation budgets and per-provider
circuits still fire, so a single turn can't blow up — but nothing stops
an unbounded sequence of turns.
**Fix (post-Day 30):** in `runAgentTurn`, before `handleUtterance`:

```ts
const usage = await getDailyUsage();
if (usage.tokens >= DAILY_MAX_TOKENS) {
  sendSafe({
    type: "error",
    code: "budget_exceeded",
    message: "Daily token budget exceeded. Try again tomorrow.",
  });
  return;
}
```

Symmetric pre-flight for the turn that crosses the line — project the
turn's cost and reject before the provider call, reusing the existing
helper instead of a second comparison:

```ts
assertDailyBudget(usage.tokens, estimateTokens(msg.text) + TOKEN_BUDGETS.agent_response);
```

Wrap it so `BudgetExceededError` becomes the same `budget_exceeded`
frame rather than an unhandled rejection (`code` is `string` on the
`error` variant, so no shared-types change is needed — RULE 1 stays
satisfied). Then a test that seeds `dailyTokens` just under the cap
(`incrementUsage({ tokens: DAILY_MAX_TOKENS - 10 })` against the
in-memory store, `resetUsageMemory()` in `afterEach`), runs one WS
turn, and asserts the next WS turn receives `budget_exceeded` and that
`handleUtterance` was not reached.
**Enforcement:** the test must fail if the guard is removed. When the
fix lands, update the failure-mode row in `docs/architecture.md`
("WS turns are not gated on the ceiling yet") and the cost bullet in
`README.md`, or the docs will claim a guarantee the code no longer
lacks — and vice versa.

---

| Package                    | Version    | Note                                   |
| -------------------------- | ---------- | -------------------------------------- |
| `fastify`                  | `^5.12.5`  | Pino built in — no pino plugin         |
| `@fastify/helmet`          | `^13.1.1`  |                                        |
| `@fastify/cors`            | `^11.3.0`  |                                        |
| `@fastify/cookie`          | `^11.1.2`  | must register before CSRF              |
| `@fastify/csrf-protection` | `^8.0.1`   | no `sessionPlugin` (ISSUE-004)         |
| `@fastify/rate-limit`      | `^11.2.0`  | `max` only, no `allowList` (ISSUE-005) |
| `@fastify/websocket`       | `^11.3.1`  |                                        |
| `@fastify/swagger`         | `^9.9.0`   |                                        |
| `@fastify/swagger-ui`      | `^6.1.1`   | `/docs`                                |
| `zod`                      | `^3.25.76` | v3 line — v4 APIs differ               |
| `dotenv`                   | `^18.0.3`  | array `path` supported                 |
| `pino-pretty` (dev)        | `^13.1.3`  | dev transport only                     |
| `tsx` (dev)                | `^4.23.15` |                                        |
| `@types/node` (dev)        | `^22.20.4` |                                        |
| `typescript` (dev)         | `^5.7.2`   |                                        |

**Banned in `packages/api/src/` and `packages/api/package.json`:** `@fastify/pino`, `pino-http`, `fastify-type-provider-zod`, `allowList`, `sessionPlugin`.

**Verification (must be clean):**

```bash
grep -rn "@fastify/pino\|pino-http\|fastify-type-provider-zod\|allowList\|sessionPlugin" packages/api/src/ packages/api/package.json  # exit 1, no output
grep -rn ": any\|<any>\|as any" packages/api/src/                                        # no output
grep -rn "from \"\./\|from \"\.\./" packages/api/src/ | grep -v "\.js\""                 # no output
pnpm turbo type-check                                                                     # 4 successful
curl -s -H "x-correlation-id: test-trace-abc" localhost:3001/health                       # echoes the id
JWT_SECRET=tooshort npx tsx src/app.ts                                                    # exit 1
```

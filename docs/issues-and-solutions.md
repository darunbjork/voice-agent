# Issues & Solutions

Every issue is tagged with the day it was hit. Constraints are binding for every later day — do not reintroduce a banned pattern.

## Index

| Issue | Day | Title |
|---|---|---|
| [ISSUE-001](#issue-001--fastifypino-does-not-exist) | **Day 3** | `@fastify/pino` does not exist |
| [ISSUE-002](#issue-002--fastify-type-provider-zod-imported-but-not-installed) | **Day 3** | `fastify-type-provider-zod` imported but not installed |
| [ISSUE-003](#issue-003--root-env-not-found-when-cwd-is-packagesapi) | **Day 3** | root `.env` not found when cwd is `packages/api` |
| [ISSUE-004](#issue-004--explicit-sessionplugin-on-csrf-registration) | **Day 3** | explicit `sessionPlugin` on CSRF registration |
| [ISSUE-005](#issue-005--allowlist-on-rate-limit-hides-localhost) | **Day 3** | `allowList` on rate-limit hides localhost |
| [ISSUE-006](#issue-006--server-must-not-auto-start-under-test) | **Day 3** | server must not auto-start under test |
| [ISSUE-007](#issue-007--no-appdecorateconfig-env-day-6-scope) | **Day 3** | no `app.decorate("config", env)` (Day 6 scope) |

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

## Appendix — locked dependency versions (packages/api)

| Package | Version | Note |
|---|---|---|
| `fastify` | `^5.12.5` | Pino built in — no pino plugin |
| `@fastify/helmet` | `^13.1.1` | |
| `@fastify/cors` | `^11.3.0` | |
| `@fastify/cookie` | `^11.1.2` | must register before CSRF |
| `@fastify/csrf-protection` | `^8.0.1` | no `sessionPlugin` (ISSUE-004) |
| `@fastify/rate-limit` | `^11.2.0` | `max` only, no `allowList` (ISSUE-005) |
| `@fastify/websocket` | `^11.3.1` | |
| `@fastify/swagger` | `^9.9.0` | |
| `@fastify/swagger-ui` | `^6.1.1` | `/docs` |
| `zod` | `^3.25.76` | v3 line — v4 APIs differ |
| `dotenv` | `^18.0.3` | array `path` supported |
| `pino-pretty` (dev) | `^13.1.3` | dev transport only |
| `tsx` (dev) | `^4.23.15` | |
| `@types/node` (dev) | `^22.20.4` | |
| `typescript` (dev) | `^5.7.2` | |

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

# Security checklist — Voice Agent

## Non-negotiables

- [x] Provider API keys only on the server (`GEMINI_*`, `DEEPGRAM_*`, `ELEVENLABS_*`)
- [x] `VOICE_MOCK=true` default in `.env.example`
- [x] CORS allowlist (not `origin: true` in production)
- [x] Helmet security headers
- [x] Global rate limit + stricter admin rate limit
- [x] Admin routes are **GET-only** (no unauthenticated writes)
- [x] User text capped at 500 characters
- [x] PCM chunk size capped (4096 bytes)
- [x] Token budget + daily ceiling + circuit breaker
- [x] Zod validation on Gemini structured output

## Before public deploy

- [x] HTTP Basic auth on `/api/v1/admin/*`
- [ ] Set `CORS_ORIGINS` to the real Pages/Fly host(s)
- [ ] Set provider spending caps (see `docs/cost.md`)
- [ ] Add real admin auth (JWT / session) before any write endpoints
- [ ] Confirm `SENTRY_DSN` only on server
- [ ] Rotate any keys that were ever pasted into chat/logs

## Intentionally deferred

- Full admin authentication (demo-local admin is read-only)
- Per-user accounts / multi-tenant isolation

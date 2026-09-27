# Deploy guide

## Architecture

| Piece | Platform             | Notes                                                        |
| ----- | -------------------- | ------------------------------------------------------------ |
| API   | Fly.io               | Docker image from `packages/api/Dockerfile`, `/health` probe |
| Web   | Vercel               | Static Vite build, `VITE_API_URL` points at Fly              |
| DB    | Neon or Fly Postgres | `DATABASE_URL` (pooled connection recommended)               |
| Redis | Upstash or Fly Redis | Optional; memory fallback works                              |

## Pre-flight

1. `docs/cost.md` provider caps are set on Deepgram / ElevenLabs / Gemini dashboards.
2. `VOICE_MOCK=true` in `fly.toml [env]`. Do not flip to `false` until you have
   watched a full live turn at least once on staging.
3. `CORS_ORIGINS` includes the Vercel production hostname AND any preview domains.
4. `ADMIN_PASSWORD` is a fresh 32-hex value generated for production. Do NOT
   reuse the local dev value.
5. `JWT_SECRET` is a fresh 32+ char value. Do NOT reuse the local dev value.

## API — first deploy

```bash
# 1. Create the app (one time)
fly apps create voice-agent-api

# 2. Provision Postgres (Fly managed, or use Neon)
fly postgres create --name voice-agent-db --region arn
fly postgres attach voice-agent-db

# 3. (Optional) Redis
fly redis create --name voice-agent-redis

# 4. Set secrets
fly secrets set \
  DATABASE_URL="postgresql://..." \
  REDIS_URL="redis://..." \
  JWT_SECRET="$(openssl rand -hex 32)" \
  ADMIN_PASSWORD="$(openssl rand -hex 32)" \
  CORS_ORIGINS="https://voice-agent.darun.dev" \
  VOICE_MOCK="true" \
  GEMINI_API_KEY="..." \
  DEEPGRAM_API_KEY="..." \
  ELEVENLABS_API_KEY="..." \
  ELEVENLABS_VOICE_ID="21m00Tcm4TlvDq8ikWAM"

# 5. Deploy
fly deploy
```

The `release_command` in `fly.toml` runs `prisma migrate deploy` in a
temporary machine before the new release receives traffic. If migrations
fail, the deploy aborts and the previous version keeps serving.

## API — verify

```bash
fly status
fly logs

curl -s https://voice-agent-api.fly.dev/health | jq
```

Expected:

```json
{
  "status": "ok",
  "db": "ok",
  "redis": "ok",
  "voiceMock": true,
  "dailyTokens": 0,
  "dailyTokenLimit": 50000,
  "timestamp": "2026-09-27T...",
  "correlationId": "...",
  "circuits": [
    {
      "provider": "gemini",
      "state": "closed",
      "failures": 0,
      "openedAt": null,
      "lastFailureAt": null
    },
    {
      "provider": "deepgram",
      "state": "closed",
      "failures": 0,
      "openedAt": null,
      "lastFailureAt": null
    },
    {
      "provider": "elevenlabs",
      "state": "closed",
      "failures": 0,
      "openedAt": null,
      "lastFailureAt": null
    }
  ]
}
```

## Web — Vercel

1. Import the repo at vercel.com.
2. **Root Directory**: repository root.
3. **Build Command**: `pnpm --filter @voice-agent/web build`
4. **Output Directory**: `packages/web/dist`
5. **Install Command**: `pnpm install --frozen-lockfile`
6. **Environment Variables**:
   - `VITE_API_URL` = `https://voice-agent-api.fly.dev`
7. Deploy. Copy the assigned production URL into Fly's `CORS_ORIGINS`:

```bash
fly secrets set CORS_ORIGINS="https://voice-agent.darun.dev,https://<project>.vercel.app"
```

Redeploy the API so the new allowlist takes effect.

## Post-deploy smoke

1. Open the Vercel URL. Voice Agent renders.
2. Click **Weather** quick action. Card renders. This exercises the full
   WebSocket round trip: connect → text_input → agent → tts_chunk → done.
3. Click **Admin**. Login form appears. Enter the production `ADMIN_PASSWORD`.
   Session list loads.
4. `curl https://voice-agent-api.fly.dev/health | jq .circuits` — all three
   circuits `closed`.

## Rollback

```bash
fly releases
fly deploy --image-label <previous-release-version>
```

For the web, Vercel keeps every deploy. Click "Promote to Production" on any
prior deploy.

## Rotating secrets

```bash
fly secrets set JWT_SECRET="$(openssl rand -hex 32)"
```

Fly restarts the app automatically. Existing JWT cookies are invalidated.

```bash
fly secrets set ADMIN_PASSWORD="$(openssl rand -hex 32)"
```

No restart needed for the next admin request, but users with a cached
`sessionStorage` value will need to re-login.

## Known limitations

- Admin uses HTTP Basic auth. Fine for demo, not for a multi-user system.
- Circuit breaker state is per-process. Fly's autostop may reset it.
- `VOICE_MOCK=true` in production keeps provider calls off. To enable live
  providers, first verify caps in `docs/cost.md`, then
  `fly secrets set VOICE_MOCK="false"`.

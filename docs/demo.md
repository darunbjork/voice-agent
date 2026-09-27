# Demo script

Practice this aloud. Every claim maps to code you shipped.

## 1. Open (10 seconds)

> "This is a production-style voice agent. It streams audio to Deepgram
> for STT, uses Gemini for reasoning with structured JSON output, and
> streams ElevenLabs back as PCM over the same WebSocket. It runs
> against mocked providers by default — real providers opt in."

Click **Start Mic**.

## 2. Voice turn

Say: **"What is the weather in Stockholm?"**

While it runs, point at the LatencyHUD:

> "The HUD breaks down STT, LLM, TTS time-to-first-chunk, and total.
> On mock that's under 50 ms. On live it's a few hundred. Green
> threshold is 500 ms — that's the number that makes voice feel fast."

Card renders. TTS plays.

## 3. Barge-in

While TTS is playing, say: **"Stop."**

> "Barge-in targets under 200 ms. VAD debounces 100 ms, then the client
> stops every active audio source and sends a barge-in frame. The server
> cancels the ElevenLabs stream. No orphaned requests, no billing for
> audio the user never heard."

## 4. Text path

Click **Help** quick action.

> "Same pipeline as voice. Text input, quick actions, and voice all
> dispatch to the same `handleUtterance` — one brain, one turn index,
> one TTS stream."

## 5. Multi-turn context

Click **Weather**, then type **"Remind me about that city tomorrow."**

> "Sessions and turns persist to Postgres. The brain receives the
> last three completed turns as context. So 'that city' resolves
> to Stockholm."

## 6. Admin

Click **Admin**. Log in with the local password.

> "Read-only ops view. Session list, per-turn transcripts and
> latency, daily token spend, circuit breaker state. GET-only,
> Basic auth, rate-limited, `no-store`."

If you left `ADMIN_PASSWORD` blank, the panel returns 503 — say so:

> "Admin is disabled unless you set a password. Blank means the surface
> is off, not that it's open."

## 7. Cost controls

While admin is open, point at the usage panel:

> "Every turn is counted. Per-operation token budgets are enforced
> before the LLM call. Provider-level caps are set in the Deepgram,
> ElevenLabs, and Gemini dashboards — documented in `docs/cost.md`.
> Circuit breakers open after five consecutive failures so a dead
> provider can't take down the whole pipeline."

## 8. Questions they will ask

**"Walk me through the latency budget."**

> STT proxy: < 5 ms mock. Intent classify: < 5 ms. Full brain
> pipeline: < 50 ms mock, 300–800 ms live. Time-to-first TTS chunk:
> < 150 ms mock. Barge-in: < 200 ms measured from first loud sample
> to silence. The HUD reports actual per-turn numbers — the mock
> figures come from those readings, the live figures are my design
> target and haven't been measured in production yet.

**"Where do the API keys live?"**

> Server only. `.env` at the repo root, gitignored. Never `VITE_*`.
> Prisma CLI reads a second local `.env`. In production, Fly secrets.
> Client bundle contains zero provider keys — verify with
> `grep -r "GEMINI\|DEEPGRAM\|ELEVENLABS" packages/web/dist` →
> empty.

**"What happens if Gemini goes down?"**

> Circuit opens after 5 failures. `safeGenerateAgentOutput` catches
> `CircuitOpenError` and returns a spoken fallback. Keyword path
> still works — weather, help, reminder, translate, summarize all
> classify without the LLM.

**"How do you prevent runaway cost?"**

> Three layers. Pre-flight: `assertWithinBudget` throws before the
> provider call. Mid-flight: circuit breaker fails fast when the
> provider is unhealthy. Post-flight: daily counter in Redis, alert
> at 80% of 50,000 tokens via structured log + optional Sentry, and
> a 429 from `costGuard` on the HTTP text route once the ceiling is
> reached.

**"Why is VOICE_MOCK the default?"**

> Safety and reproducibility. A fresh clone does not spend a cent.
> Tests run in CI without network. Demos don't depend on provider
> quotas. Live is opt-in: set `VOICE_MOCK=false` and the keys, after
> confirming caps in `docs/cost.md`.

**"What would you do next?"**

> Move circuit state to Redis so I can run more than one replica,
> gate the WebSocket path on the daily ceiling the same way the HTTP
> route is gated, and take a real production latency measurement
> against the Fly deploy so the estimated column of the budget table
> becomes measured.

# Voice Agent — Cost Controls & Provider Caps

> This document must exist and provider-level caps must be set BEFORE any real API key is used (VOICE_MOCK=false).

**Author:** Darun Mustafa
**Date:** 2026-09-25

## 1. Hard Spending Caps (Provider Dashboards)

| Provider | Console | Recommended Cap | How to set it | Screenshot path |
|---|---|---|---|---|
| Deepgram | https://console.deepgram.com | $10 / month | Project → Settings → Billing → Spending Limits | `docs/screenshots/deepgram-cap.png` |
| ElevenLabs | https://elevenlabs.io/usage | 80% alert of free tier | Account → Subscription → Usage alerts | `docs/screenshots/elevenlabs-alert.png` |
| Gemini | Google AI Studio + Cloud Console | $10 / month | AI Studio → API keys → Budget alerts; Cloud Billing → Budgets & alerts | `docs/screenshots/gemini-budget.png` |

Action checklist:

1. Log in to each of the three consoles above and set the recommended cap (or the closest available alert).
2. Take the screenshot for each provider and save it at the path listed in the table.
3. Confirm every screenshot shows an active cap or alert — not a pending one.
4. Re-read Section 3 and confirm the application-level budgets match what `packages/api/src/utils/token-budget.ts` enforces.
5. Commit this file. Only then is it legal to set VOICE_MOCK=false.

## 2. Current Unit Prices (approximate, Sep 2026)

| Provider | Unit | Price |
|---|---|---|
| Deepgram Nova-2 (STT) | 1 minute of audio | ~$0.0043–$0.0058 |
| ElevenLabs Turbo/Flash (TTS) | 1000 characters | ~$0.05 |
| Gemini 1.5 Flash (LLM) | 1M input tokens | ~$0.075–$0.15 |

Worked example — one 5-minute voice session:

| Step | Usage | Cost |
|---|---|---|
| STT | 5 min audio | ~$0.0275 |
| TTS | ~2400 characters | ~$0.12 |
| LLM | ~15k input + output tokens | ~$0.001 |
| **Total** | | **≈ $0.15** |

At 1000 sessions/month that is ≈ **$150** — which is exactly why the caps in Section 1 exist.

## 3. Application-Level Budgets (enforced in code)

| Operation / limit | Value |
|---|---|
| `agent_classify` | 200 tokens |
| `agent_response` | 500 tokens |
| `session_summary` | 300 tokens |
| `daily_max_tokens` | 50,000 tokens |

- **Pre-flight check** — `assertWithinBudget(...)` runs before any paid call; an over-budget estimate throws `BudgetExceededError` and the network is never touched.
- **Redis daily counter + Sentry at 80%** — usage is counted per day; crossing 80% of `daily_max_tokens` raises an alert (`isApproachingDailyLimit()`).
- **Idempotency key** — `voice:turn:{sessionId}:{turnIndex}`, TTL 60s, so a retried turn cannot double-bill.
- **Circuit breaker** — provider calls stop on repeated failure (Day 19).

## 4. `VOICE_MOCK=true` (default)

- `VOICE_MOCK=true` means **zero provider calls**: STT, TTS and the LLM are served by deterministic mocks in `packages/api/src/utils/voice-mock.ts`.
- It is the value shipped in `.env.example` and enforced through `env.VOICE_MOCK` — never a hard-coded literal.
- Setting it to `false` requires Section 1 caps to be live and this file committed.

## 5. Runbook — "I think we are burning money"

1. `curl -s localhost:3001/health | jq '.dailyTokens, .dailyTokenLimit, .voiceMock'` — confirm the current burn and whether mocks are off.
2. Check the provider dashboards (Section 1) for the same period — Deepgram usage, ElevenLabs characters, Gemini token spend.
3. If the app counter and the dashboard disagree, trust the dashboard, then check for a process restarted mid-day (the in-memory counter resets).
4. If spend is real and unexpected: set `VOICE_MOCK=true` in `.env`, restart the API — this cuts every paid path immediately.
5. File what happened (which operation, which provider) and only return to live keys after the caps are re-verified.

## 6. Change Log

| Date | Author | Change |
|---|---|---|
| 2026-09-25 | Darun Mustafa | Initial cost.md + $10 caps + token budgets |

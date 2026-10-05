# Voice pipeline bugfix report — mic/STT + translate (2026-10-05)

Report of every error found during the live-mode debugging session, with root
cause, fix, and verification. All fixes are uncommitted on `feat/live-tool-backends`.

## Summary

| # | Error | Severity | Status |
|---|-------|----------|--------|
| 1 | PCM bytes corrupted in `useAudioCapture` — mic audio never transcribable | Critical | Fixed |
| 2 | Translate card used stale hardcoded `hello` as the original | Major | Fixed |
| 3 | Meaning-question extraction missed transcripts without `what` / with STT `dose` | Major | Fixed |
| 4 | "What does *weather* mean in Swedish" routed to the weather tool | Minor | Fixed |
| 5 | Live Gemini translate failed on transient 503 / quota 429 | Minor | Mitigated (retry + honest fallback) |

Verification: API tests **112/112**, web tests **77/77**, `pnpm lint`,
`pnpm turbo type-check` (4/4), `pnpm format:check` — all clean.

---

## 1. Critical: mic PCM bytes corrupted before reaching STT

**Symptoms**

- UI shows `Listening`, mic permission granted, VAD `speech_start/speech_end` fires,
  ~32 KB/s of audio is sent over the WebSocket — but Deepgram never returns even an
  interim transcript. Exactly the reported "mic doesn't record / no speech-to-text".

**Root cause** — `packages/web/src/hooks/useAudioCapture.ts:150` (shipped in PR #7,
commit `7b1711a`):

```ts
const arrayBuffer = new ArrayBuffer(int16.byteLength);
new Uint8Array(arrayBuffer).set(int16);   // BUG
```

`TypedArray.prototype.set` called with a typed array of a *different element size*
per spec performs an **element-wise numeric conversion** (each `Int16` → `ToUint8`,
i.e. modulo 256) — **not** a raw byte copy. Example from Node (same spec as browsers):

```
Int16Array [-1, 3282, -32768, 32767]
after new Uint8Array(buf).set(int16):  [255, 210,   0, 255]   // corrupted
expected little-endian bytes:          [255, 255, 210, 12, 0, 128, 255, 127]
```

Every sample was destroyed. The wire carried high-entropy, constant-RMS noise
(measured: sent frame RMS pinned at ≈13 400 regardless of the speech envelope;
lag-correlation with the true input ≈ 0), which Deepgram correctly transcribes as `""`.

**Why it was never caught**

- `VOICE_MOCK=true` mock STT only counts chunks — it never reads the bytes.
- Direct WebSocket tests streamed pristine TTS audio, bypassing the app's packing.
- API tests don't cover frontend audio code. The bug therefore only appeared in
  live mode (`VOICE_MOCK=false`).

**Fix**

```ts
const int16 = float32ToInt16(samples);
const arrayBuffer = new Uint8Array(
  int16.buffer,
  int16.byteOffset,
  int16.byteLength,
).slice().buffer as ArrayBuffer;          // raw byte copy
```

**Proof**

- Same-event capture (app's `inputBuffer` vs. what the app sends):
  before → Deepgram `""`; after → `mse = 0`, identical frame-RMS envelopes,
  Deepgram transcript `"hello what does the word high mean in swedish…"`.
- Full headless-browser E2E with speech audio → user transcript, agent reply and
  TTS all render in the chat UI.

**Related (no fix needed)** — `packages/api/src/modules/audio/audio.routes.ts:197`
uses the same `.set()` idiom, but there the source is a Node `Buffer`
(a `Uint8Array`), so element sizes match and the copy is byte-exact.

---

## 2. Translate card showed stale `hello` → `hej`

**Symptoms**

- "What does the word high mean in Swedish?" produced a card
  `ORIGINAL hello / TRANSLATED hej` and the reply "hello in Swedish is hej." —
  the exact stale "hello world" behaviour reported.

**Root cause** — `packages/api/src/modules/agent/tools/translate.tool.ts`,
`extractOriginal()` only matched imperative phrasings:

```ts
/\b(?:translate|say)\s+["']?(.+?)["']?\s+in\s+\w+/i
```

Question forms ("What does X mean in Swedish") never matched, so the tool fell
through to the hardcoded fallback `|| "hello"` (line 55). The classifier's
`translate` rule had the same gap: it matched the intent via the `in <lang>`
pattern but returned empty slots.

**Fix** — two extraction branches added to both the tool (`extractOriginal`) and
the classifier (`translate` rule `extract`):

```
\b(?:what(?:'s|\s+)?)?(?:is|dose|does|do)\s+(?:the\s+)?(?:word\s+)?(.+?)\s+means?\s+in\s+(\w+)
\b(?:what(?:'s|\s+)?)?is\s+(?:the\s+)?meaning\s+of\s+(.+?)\s+in\s+(\w+)
```

Edge quotes are stripped from the captured original.

**Proof** — browser E2E after the fix: card `ORIGINAL high → TRANSLATED hög`,
reply "high in Swedish is hög." (live Gemini).

---

## 3. Meaning-question variants the extractor still missed

Found while replaying real STT transcripts:

| Transcript form | Problem |
|-----------------|---------|
| `Does the word high mean in Swedish?` (STT often drops the leading *what*) | First patterns required `what…` → no match → stale `hello` again |
| `What dose high mean in Swedish?` (ASR mishears *does* as *dose*) | Not in the verb alternation |
| `What is the meaning of well-done in German?` | A single combined regex required a trailing `mean(s)` after the target, which this phrasing doesn't have |

**Fix** — patterns rewritten so the sentence **verb** (`is|dose|does|do`) is the
required anchor and `what` is optional; `meaning of … in <lang>` split into its
own branch (no trailing `mean` needed). Applied in
`intent.classifier.ts` and `translate.tool.ts`.

**Tests added** (`intent-classifier.test.ts`, `tools.test.ts`): `dose`, dropped
`what`, `meaning of`, plus end-to-end classify→tool cases asserting
`card.original` is the asked word and never `hello`.

---

## 4. Weather intent stole translate questions

**Symptom** — "What does weather mean in Swedish" was classified as `weather`
(keyword match on "weather") and geocoded "Swedish Knoll, United States" instead
of translating the word.

**Root cause** — `packages/api/src/modules/agent/intent.classifier.ts`,
`KEYWORD_RULES` order: the `weather` rule runs before `translate`, and its keyword
pattern matched any occurrence of `weather|temperature|forecast|rain|…`.

**Fix** — negative lookahead on the weather keyword pattern only:

```ts
/\b(weather|temperature|forecast|rain|sunny|cloudy|humid)\b(?!\s+means?\s+in\b)/i,
```

Legitimate weather questions ("What is the weather in Stockholm?", "Does it rain
tomorrow?") still classify as `weather`; meaning-questions fall through to the
`translate` rule (matched via its `in <lang>` pattern).

---

## 5. Live Gemini translate intermittently unavailable

**Symptoms**

- Card/reply: `I do not have a translation for "high" to Swedish yet.` despite a
  configured key (previously masked because `hello` hits the demo dictionary).

**Root causes** (measured by calling `generateToolText` directly)

- Transient provider errors: `503 UNAVAILABLE — "This model is currently
  experiencing high demand"` (worked on immediate retry).
- Free-tier quota: `429 — "You exceeded your current quota"` after repeated
  probes; after 5 consecutive failures the in-process circuit breaker opens
  (`circuit-breaker.ts`, 30 s window → half-open probe).

**Fix / mitigation**

- `liveTranslate` now retries once after 700 ms before falling back
  (`translate.tool.ts`). Existing protections (token budget assertion,
  circuit breaker, dictionary fallback, honest "no translation" reply) unchanged.
- Quota exhaustion is provider-side — it resets on Google's schedule; the tool
  degrades gracefully instead of failing the turn.

---

## Ruled out during investigation (not bugs)

- Server-side STT: direct Deepgram WS test and the same test through the Vite
  proxy (`ws://localhost:5173/api/ws/audio`) both returned interim + final
  transcripts — `audio.routes.ts` / `deepgram.proxy.ts` are healthy.
- Vite proxy config (`/api` → `:3001`, `ws: true`), session setup (`session_id`
  received), sample rate/encoding (16 kHz `linear16` on both sides), mic
  permission, `MicButton` state machine, `useVAD`/`useWaveform`/`useDeepgramProxy`,
  feedback tone, React StrictMode.

## Debugging pitfalls (harness artifacts — do not re-chase)

1. Defining `onaudioprocess` **per instance** with `Object.defineProperty` broke
   Chrome's IDL event-handler slot → false "0 frames captured". Use
   `node.addEventListener("audioprocess", …)` counters instead.
2. Chrome's `--use-file-for-fake-audio-capture` delivered pure silence in this
   headless setup, and `AudioContext` intermittently reported audio-device
   errors — harness-only artifacts, not app defects.
3. `TypedArray#set` cross-element-size semantics (bug #1) — always copy PCM via
   `new Uint8Array(int16.buffer, byteOffset, byteLength)` views, never
   element-wise `.set(int16Array)`.

## Files changed

```
packages/api/src/modules/agent/intent.classifier.ts      (weather guard + extraction)
packages/api/src/modules/agent/tools/translate.tool.ts   (extraction + live retry)
packages/api/src/__tests__/intent-classifier.test.ts     (+9 cases)
packages/api/src/__tests__/tools.test.ts                 (+3 cases)
packages/web/src/hooks/useAudioCapture.ts                (PCM byte-copy fix)
```

## Verification commands

```bash
GEMINI_API_KEY= pnpm --filter @voice-agent/api test   # 112/112
pnpm --filter @voice-agent/web test                    # 77/77
pnpm lint && pnpm turbo type-check && pnpm format:check
```

# 📜 The Master Rulebook v2.4: Production-Grade Constitution

## 🏛️ Pillar 0: The Hierarchy of Priorities

When rules conflict, resolve them using this strict order:

**Accessibility > Security > Correctness (Data Integrity) > Testing > Observability > Performance > Consistency > Aesthetics.**

*Note: Pillar order in this document reflects logical grouping (design → build → secure → test → ship), not conflict priority. The priority order above is the sole authority for resolving conflicts. When a beautiful animation breaks accessibility, accessibility wins. When a fast UI relies on insecure data, security wins. When a consistent pattern produces incorrect data, correctness wins. Testing and Observability rank above Performance because prevention and measurement both precede optimization — you cannot safely speed up what you haven't verified or can't see.*

---

## 🎨 Pillar 1: Design System Foundations (The "Look")
*Never guess. Always use tokens.*

1. **The 8-Point Grid:** All margins, padding, and gaps must be multiples of 8 (8, 16, 24, 32, 48). Use 4px increments *only* for micro-tweaks.
2. **The 60-30-10 Color Rule:** 60% Neutral (backgrounds), 30% Secondary (UI elements), 10% Accent (CTAs).
3. **Strict Typography Scale (Default):** Use a maximum of 4 sizes (H1: 32px, H2: 24px, Body: 16px, Caption: 12px). *Nuance:* This is a constraint to prevent decision fatigue, not an absolute law. Data-heavy dashboards often require 5-6 sizes for real hierarchy.
4. **Limit Fonts & Weights (Default):** Use a maximum of 2 font families and 3 weights. *Nuance:* The goal is reducing visual noise, not adherence to an arbitrary number. If a brand requires a specific display font, adapt.
5. **WCAG AA Contrast:** Text must have a minimum contrast ratio of 4.5:1 against its background. Never use dark gray text on a black background.
6. **Subtle Depth:** Use shadows softly (5-20px blur, 5-15% opacity) to lift cards off the background.

---

## 🎭 Pillar 2: UX & Interaction (The "Feel")
*Make it feel alive, human, and intentional.*

7. **Actionable Empty States:** Never show a blank screen. Explain *why* it's empty and provide a clear CTA.
8. **Outcome-Driven CTAs:** Button labels must tell the user exactly what will happen (e.g., "Save to Shortlist" instead of "Submit").
9. **Micro-Interactions:** Every clickable element must have a `hover`, `focus`, and `active` state. Keep animations fast (100–300ms).
10. **Proximity Grouping:** Group related elements tightly (Label to Input: 8px). Separate distinct sections (Input to Button: 24px).
11. **Real Data Only:** Never use "Lorem Ipsum" in final designs. Design for long names, missing data, and edge cases from day one.
12. **Instant, Contextual Errors:** Surface errors immediately, directly below the field causing them. Explain how to fix it. *Security Note:* Client-side validation is for UX only. Server must re-validate everything (see the **Server-Side Validation** rule).

---

## ♿ Pillar 3: Accessibility & Inclusive Design (The "Standard")
*Accessibility is not a feature; it is a requirement and outranks security in our hierarchy.*

13. **Semantic HTML:** Use `<nav>`, `<main>`, `<button>`, `<header>` correctly. Never use a `<div>` as a button.
14. **Keyboard Navigation:** The entire app must be navigable using `Tab`, `Enter`, and `Space`. Visible focus rings are mandatory.
15. **ARIA Live Regions:** Use `aria-live="polite"` for dynamic content (streaming text, toasts, chat messages).
16. **Touch Targets:** All interactive elements must be at least 48x48px on mobile.
17. **Reduced Motion:** Respect `prefers-reduced-motion`. Ensure animations are disabled for users who prefer static interfaces.

---

## 🛡️ Pillar 4: Security (The "Shield")
*Security is a requirement, not a feature.*

18. **Server-Side Validation:** Never trust client validation. Server re-validates everything, always. Client-side checks are for UX, not security.
19. **Sanitize on Output:** XSS prevention is about what you render, not just what you accept. `dangerouslySetInnerHTML` needs a sanitizer (DOMPurify) or a documented reason it's safe.
20. **Secrets Never Touch the Client:** Env vars prefixed for client exposure (`NEXT_PUBLIC_`, `VITE_`) are public. Treat them as such — no API keys, no internal URLs.
21. **Auth Token Lifecycle:** Access tokens are short-lived. Refresh tokens are rotated on use. The client has a defined behavior for expired-token responses (silent refresh vs. forced re-auth), not an ad-hoc 401 handler scattered across API calls.
22. **Rate Limiting & Abuse Controls:** Rate limit auth endpoints. Throttle anything that hits an expensive API (like an LLM API) to prevent cost-based DoS attacks.
23. **Dependency Audits in CI:** `npm audit` / Snyk / Dependabot wired into the pipeline, not manually run before a release.

---

## 📐 Pillar 5: Correctness & Data Integrity (The "Truth")
*Wrong data is worse than slow data.*

24. **Database Migrations:** Migrations must be versioned, reversible, and run through a pipeline. Never run them manually against production.
25. **Transaction Boundaries:** Any operation that mutates more than one record must be wrapped in a transaction. Partial writes are data corruption.
26. **Idempotency on Writes:** All mutation endpoints (POST/PUT/DELETE) must be idempotent, or documented as intentionally not. This prevents duplicate charges, duplicate records, and duplicate LLM calls.

---

## 🏗️ Pillar 6: Frontend Architecture & State (The "Build")
*Write code that a senior engineer would applaud.*

27. **State Machines (FSM) — When Necessary:** Use an FSM when states have illegal combinations to prevent (e.g., "loading" and "error" true simultaneously). A simple boolean is fine for two-state toggles. Do not over-engineer with XState for a dropdown.
28. **Server State Management:** Never hand-roll server state with manual `useEffect` + `useState` fetching. Use React Query, SWR, or RTK Query. This solves stale closures, race conditions, and memory leaks inherently.
29. **Optimistic Updates Need Rollbacks:** If you implement optimistic UI, define exactly what happens when the server rejects the mutation. Never leave the UI in a false "success" state.
30. **AbortControllers:** Every async network request must be abortable. Clean up on component unmount.
31. **Atomic Design:** Build small, reusable primitives (Button, Input, Card) before building feature-specific components.
32. **Strict TypeScript:** Zero `any`. Define interfaces for all API responses. Use `unknown` and type guards if necessary.

---

## ⚡ Pillar 7: Performance (The "Speed")

33. **Lazy Loading & Code Splitting:** Lazy load non-critical components and routes to minimize initial bundle size.
34. **Image Optimization:** Serve WebP or AVIF. Set explicit `width` and `height` to prevent layout shifts (CLS).
35. **Memoization:** Use `useMemo` and `React.memo` for expensive computations and pure components to prevent unnecessary re-renders.
36. **Performance Budgets:** Define and enforce limits on bundle size and Time to Interactive (TTI) in the CI pipeline.

---

## 🧪 Pillar 8: Testing (The "Regression Shield")
*If it's not tested, it's broken.*

37. **Test the State Machine, Not the UI:** Write tests against state transitions (`idle→loading→error`), not pixel snapshots.
38. **Integration Tests Over Unit Tests for React:** Use Testing Library (`render`, `userEvent`) on real component trees. Reserve unit tests for actual business logic (pricing calculations, date math, validation rules).
39. **E2E on the Critical Path Only:** One Playwright/Cypress flow per money-making action (signup, checkout, primary CTA). Comprehensive E2E suites become maintenance tax.

---

## 📊 Pillar 9: Observability & Resilience (The "Flight Recorder")
*Know when things break, for users you'll never talk to.*

40. **Structured Error Reporting:** Wire Sentry (or equivalent) before first deploy. Include user context, not just stack traces.
41. **Log What You'll Need to Debug:** Structured logs (JSON, leveled) on the backend. Avoid logging PII by default. Overlogging is as bad as underlogging.
42. **Alerting Thresholds:** Logging tells you what happened. Alerting tells you *before* a user complains. Define SLOs (e.g., p99 latency, error rate) and wire alerts to them.
43. **Graceful Degradation:** Handle offline states, API timeouts, and permission denials (e.g., microphone access) with clear, illustrated UI states.

---

## 🚀 Pillar 10: Release & Deployment (The "Deploy")
*Ship dark, flip on.*

44. **Config by Environment, Not by Comment:** `.env.development` / `.env.production`, never a commented-out URL swap in source.
45. **Feature Flags for Anything Risky:** Ship dark, flip on. This makes "one fix, one commit" meaningful.
46. **CI/CD Pipeline Definition:** Minimum gate sequence before merge: **lint → type-check → test → build → audit**. Dependency audits run in the pipeline, not manually.
47. **Rollback/Incident Runbook:** Every deploy has a defined rollback path. For a solo dev, `git revert` + redeploy is always faster than debugging in prod. Document this.

### 🚦 Rule 48: The Merge Gate (Mechanical Checklist)

Every PR must pass this mechanical checklist before merge. Not vibes. Not "looks good to me." Run it:

- [ ] `git log` — commit messages follow the pattern (`feat:`, `fix:`, `chore:`, `refactor:`)
- [ ] `npm run lint` — passes with zero warnings
- [ ] `npm run type-check` — zero TypeScript errors, no `any`
- [ ] `npm run test` — all tests pass, coverage on critical paths unchanged or improved
- [ ] `npm run build` — production build succeeds locally
- [ ] `npm audit --production` — zero high/critical vulnerabilities
- [ ] **Referential integrity check** (see script below) — no malformed references, no broken references
- [ ] **Accessibility check:** run Lighthouse or Axe on the primary page — no new violations
- [ ] **Rollback path documented:** if this PR adds a feature flag or migration, the rollback is written in the PR body
- [ ] **Manual verification section:** if this PR touches Auth Token Lifecycle, Rate Limiting, Transaction Boundaries, Idempotency, or Alerting Thresholds, the PR body includes a `## Manual verification` section describing how it was checked. Absence blocks merge for PRs touching these surfaces.

**Referential integrity check — two-stage script:**

```bash
# Stage 1 — every "see the ... rule" reference must match the required
# bold format. Anything else fails loud instead of being silently skipped.
if grep -nE 'see the .* rule' RULES.md \
   | grep -vE 'see the \*\*[^*]+\*\* rule'; then
  echo "MALFORMED REFERENCE — reference does not match required format"
  exit 1
fi

# Stage 2 — every well-formed reference must resolve to an existing rule title.
grep -oP 'see the \*\*[^*]+\*\* rule' RULES.md \
  | sed -E 's/see the \*\*//; s/\*\* rule//' \
  | while read -r name; do
      grep -qE "^[0-9]+\. \*\*${name}" RULES.md || echo "BROKEN REF: $name"
    done
```

Zero output from Stage 2, and a non-zero exit only from Stage 1 on genuinely malformed input = pass.

**Scope of this gate, stated honestly:** this checklist enforces the subset of rules that are machine-checkable. Rules governing runtime behavior under load or in production — Auth Token Lifecycle (Rule 21), Rate Limiting (Rule 22), Transaction Boundaries (Rule 25), Idempotency (Rule 26), and Alerting Thresholds (Rule 42) — cannot be verified by this gate and require explicit manual sign-off per the checklist item above.

**Known limitations of the referential integrity script (accepted, not fixed):**
- Stage 1's greedy `.*` can misattribute *which* reference is malformed when two `see the ... rule` phrases appear on the same line. The check still fails loud and blocks merge correctly — only the diagnostic message is imprecise. Accepted because the failure is diagnostic-only, not an enforcement gap, and the edge case is rare.
- Rule-title matching in Stage 2 is prefix-based, not exact-title. A reference to `Server-Side Validation` would also match a hypothetical future rule titled `Server-Side Validation Timeouts`. Currently open and inert: no two rule titles in this document are prefixes of one another, so this cannot misfire against the file as it stands. It becomes live only if a future rule introduces a title that is a prefix of another existing title.

---

## 🧠 Pillar 11: AI-Assisted Workflow (The "Process")
*How to use AI to build better apps, faster.*

49. **The `DESIGN.md` First:** Before writing a single line of code, generate a `DESIGN.md` that defines your tokens.
50. **AI Self-Critique (With Caveats):** Asking the same model to critique its own solution in the same context is low-value — it shares the blind spots of the reasoning that produced the solution. Start a *new* conversation with fresh context, or use a tool that actually executes the check rather than reasons about it. For security, do not rely on AI judgment alone. Run concrete tools: `npm audit`, ESLint security plugins, and a pinned SAST tool (e.g., Semgrep). A claim that something "passes" is only as good as whether it was actually run, by something capable of running it — not narrated as run by the same context that wrote it.
51. **One Fix, One Commit:** Never bundle unrelated changes. `fix(navbar): contrast` and `feat(chat): add barge-in` must be separate commits.
52. **Mobile-First Verification:** Always test in Chrome DevTools at 375px (iPhone SE) *before* testing on a desktop viewport.
53. **Real Device Testing:** DevTools emulators lie. Test the final build on a physical phone before deploying.
54. **The "Senior Dev" Check:** Before shipping, ask: *"Would a senior engineer look at this code and UI and trust me to build their production system?"* If the answer is no, find out why and fix it.

---

### 🏆 The Golden Rule

**"A good app works. A great app is accessible, secure, correct, tested, observable, performant, consistent, and feels inevitable."**

*Note: The listing order in this sentence is not priority order. See Pillar 0 for the authoritative hierarchy.*

If the user has to guess how to do something, the design has failed. If the code breaks when the API goes down, the architecture has failed. If a screen reader user can't navigate it, the engineering has failed. If you don't know an error occurred in production, the operations have failed. If the Merge Gate has unchecked boxes, the discipline has failed. Build with intention, not just instruction.

---

## Revision History

**v2.2** — Fixed the broken numbered cross-reference (Rule 12 → Rule 18) by converting all cross-references from `see Rule N` to named references (`see the [Rule Name] rule`), removing renumbering fragility. Resolved the pillar-order-vs-priority-order contradiction by adding an explicit disclaimer to Pillar 0. Added Pillar 5 (Correctness & Data Integrity) — migrations, transaction boundaries, idempotency — as a top-level concern instead of a subsection of Security. Added Rule 48 (The Merge Gate), a mechanical pre-merge checklist.

**v2.3** — Folded Testing and Observability into Pillar 0's hierarchy (previously present in the Golden Rule's seven qualities but absent from the six-tier priority list). Added a matching disclaimer to the Golden Rule noting its listing order is not priority order. Attempted a fix to the Merge Gate's referential-integrity check and a scoping correction removing the overclaim that the gate enforces "every other rule." **Both fixes in this version were asserted as verified in a self-audit that was never actually executed** — the audit table claimed a passing regex match without running the script. This was identified as verification theater: the exact failure mode Rule 50 exists to prevent, produced in the act of citing Rule 50.

**v2.4** — The referential-integrity script was corrected and *actually executed* against representative test files, by a context capable of running it rather than reasoning about it. Verified by execution: well-formed references pass silently; malformed (unbolded) references now fail loud instead of being silently skipped, closing a real under-detection gap; a two-references-on-one-line edge case was tested and found to produce a correct block with an imprecise diagnostic message. That limitation is accepted, not fixed, for stated reasons (diagnostic-only, rare, low cost to recover from). Prefix-ambiguity in rule-title matching remains open, and is further qualified as currently inert — no rule title in this document is presently a prefix of another, so the ambiguity cannot occur against the file as it stands today; it would need a future rule addition to become live.

**Standing lesson encoded by this history:** a self-audit performed by the same reasoning that wrote the change inherits that reasoning's blind spots. Verification claims in this document's own maintenance are only as good as whether they were executed by something capable of executing them — not narrated as executed.
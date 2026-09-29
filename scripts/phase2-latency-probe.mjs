import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_ORIGIN = "http://localhost:3001";
const WEB_ORIGIN = "http://localhost:5173";
const DOC_PATH = path.join(root, "docs", "phase-2-ac-probe.md");

const measured = [];
const derived = [];
const attempts = [];

let PASS = "setup";

function recordMeasured(id, label, ms, target, notes) {
  measured.push({ id: `${PASS}:${id}`, label: `[${PASS}] ${label}`, ms, target, notes });
}

function recordDerived(id, label, value, source) {
  derived.push({ id, label, value, source });
}

function recordAttempt(id, label, outcome, detail) {
  attempts.push({ id: `${PASS}:${id}`, label: `[${PASS}] ${label}`, outcome, detail });
}

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

function findChrome() {
  return chromeCandidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHttp(url, timeoutMs, isOk = httpOk) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOk(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function startChild(label, command, args, extraEnv) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  return {
    label,
    logs,
    child,
    kill() {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    },
  };
}

async function ensureService(label, url, command, args, extraEnv) {
  if (await httpOk(url)) {
    recordAttempt(label, `existing ${label} service`, "reused", `${url} already responded`);
    return { owned: false };
  }
  const proc = startChild(label, command, args, extraEnv);
  const up = await waitForHttp(url, 60_000);
  if (!up) {
    proc.kill();
    const tail = proc.logs.join("").split("\n").slice(-25).join("\n");
    throw new Error(`${label} did not come up at ${url}. Last output:\n${tail}`);
  }
  recordAttempt(label, `start ${label} service`, "ok", `${url} up (spawned by probe)`);
  return { owned: true, proc };
}

async function waitForStatus(page, text, timeoutMs) {
  await page.waitForFunction(
    (expected) => document.querySelector(".status-value")?.textContent === expected,
    { timeout: timeoutMs, polling: 4 },
    text,
  );
}

function pushDerived() {
  recordDerived(
    "capture-frame",
    "Capture frame interval (512 samples @ 16 kHz)",
    "32.0 ms",
    "packages/web/src/hooks/useAudioCapture.ts:119 (Phase 2, commit 93b4a81)",
  );
  recordDerived(
    "capture-frame-before",
    "Capture frame interval before Phase 2 (2048 samples @ 16 kHz)",
    "128.0 ms",
    "git history: same line before commit 93b4a81",
  );
  recordDerived(
    "vad-window",
    "VAD speech-detection window for voice barge-in",
    ">=100 ms and <=132 ms (minSpeechMs + one frame)",
    "packages/web/src/App.tsx VAD_MIN_SPEECH_MS=100 + frame interval above",
  );
  recordDerived(
    "voice-barge-in",
    "Voice barge-in floor (VAD window + synchronous cancel + next paint)",
    "<=149 ms (132 + 0 + 16.7), i.e. within the 300 ms target on paper",
    "derived: vad-window + synchronous tts.cancel() + one rAF frame (16.7 ms @ 60 Hz)",
  );
  recordDerived(
    "mock-stt-final",
    "Mock STT final after the 8th audio chunk",
    ">=256 ms of captured audio (8 x 32 ms)",
    "packages/api/src/modules/audio/deepgram.proxy.ts (mock final after the 8th chunk of one audio burst)",
  );
  recordDerived(
    "mock-tts-cadence",
    "Mock TTS chunk cadence",
    "40 ms between chunks, 3-8 chunks per reply",
    "packages/api/src/modules/audio/elevenlabs.service.ts:77 (setTimeout 40 * i)",
  );
}

async function runScenarios(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(WEB_ORIGIN, { waitUntil: "load", timeout: 30_000 });
  await page.waitForSelector('button[aria-label="Start microphone"]', { timeout: 15_000 });

  const t0 = Date.now();
  await page.click('button[aria-label="Start microphone"]');

  try {
    await waitForStatus(page, "Listening", 12_000);
    const micHot = Date.now() - t0;
    recordMeasured(
      "mic-tap-listening",
      "Mic tap -> status 'Listening' (visual feedback)",
      micHot,
      "<=200 ms",
      "headless Chrome + fake mic; includes puppeteer click round-trip (~ms, biases high)",
    );
  } catch {
    const seen = await page
      .evaluate(() => ({
        status: document.querySelector(".status-value")?.textContent ?? "(none)",
        excerpt: document.body.innerText.replace(/\s+/g, " ").slice(0, 220),
      }))
      .catch(() => null);
    recordAttempt(
      "mic-tap-listening",
      "mic tap -> Listening",
      "fallback",
      `status never reached 'Listening' within 12 s; status=${seen?.status ?? "unknown"}; page: ${seen?.excerpt ?? "unavailable"}`,
    );
    await page.close().catch(() => {});
    return;
  }

  const listeningAt = Date.now();
  try {
    await waitForStatus(page, "Processing", 8_000);
    recordMeasured(
      "listening-processing",
      "Status 'Listening' -> 'Processing' (mic audio -> mock STT final)",
      Date.now() - listeningAt,
      "informational",
      "mock STT keys off the 8th audio chunk (see derived: mock-stt-final)",
    );
    recordMeasured(
      "tap-processing",
      "Mic tap -> status 'Processing' (full path)",
      Date.now() - t0,
      "informational",
      "cumulative anchor at the click",
    );
  } catch {
    recordAttempt(
      "listening-processing",
      "Listening -> Processing",
      "fallback",
      "mock transcript_final never arrived (WS/proxy issue) — see service logs",
    );
    await page.close().catch(() => {});
    return;
  }

  const processingAt = Date.now();
  try {
    await waitForStatus(page, "Speaking", 8_000);
    recordMeasured(
      "processing-speaking",
      "Status 'Processing' -> 'Speaking' (agent reply + first TTS chunk)",
      Date.now() - processingAt,
      "informational",
      "mock agent pipeline + mock TTS cadence, no real LLM/TTS latency",
    );
  } catch {
    recordAttempt(
      "processing-speaking",
      "Processing -> Speaking",
      "fallback",
      "first tts_chunk never reached the page",
    );
    await page.close().catch(() => {});
    return;
  }

  try {
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Interrupt agent speech"]')?.disabled,
      { timeout: 3_000, polling: 25 },
    );
    const t1 = Date.now();
    await page.click('button[aria-label="Interrupt agent speech"]');
    await page.waitForFunction(
      () => document.querySelector(".status-value")?.textContent !== "Speaking",
      { timeout: 5_000, polling: 4 },
    );
    recordMeasured(
      "interrupt-speaking",
      "Interrupt button -> status leaves 'Speaking'",
      Date.now() - t1,
      "<=300 ms (button path)",
      "voice barge-in not deliberately driven; see the app log excerpt for whether the VAD auto-fired with fake audio",
    );
  } catch {
    recordAttempt(
      "interrupt-speaking",
      "Interrupt -> not Speaking",
      "fallback",
      "speaking window ended before the interrupt landed, or click was ignored",
    );
  }

  try {
    const bodyText = await page.evaluate(() => document.body.innerText);
    const logLines = bodyText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) =>
        /barge-in|speech_start|speech_end|TTS done|TTS cancelled|final \(|thinking/.test(line),
      )
      .slice(-24);
    if (logLines.length > 0) {
      recordAttempt("app-log", "debug log excerpt", "info", logLines.join(" | "));
    }
  } catch {
    /* log capture is best-effort */
  }

  await page.close().catch(() => {});

  const page2 = await browser.newPage();
  await page2.goto(WEB_ORIGIN, { waitUntil: "load", timeout: 30_000 });
  await page2.waitForSelector("#voice-agent-text-input", { timeout: 15_000 });
  const t2 = Date.now();
  await page2.click("#voice-agent-text-input");
  await page2.type("#voice-agent-text-input", "what is the weather");
  await page2.keyboard.press("Enter");
  try {
    await waitForStatus(page2, "Processing", 8_000);
    recordMeasured(
      "text-processing",
      "Text submit -> status 'Processing' (text_input round trip)",
      Date.now() - t2,
      "informational",
      "no microphone involved; server replies transcript_final immediately in mock mode",
    );
  } catch {
    recordAttempt(
      "text-processing",
      "text submit -> Processing",
      "fallback",
      "text_input path never reached 'Processing' within 8 s",
    );
  }
  await page2.close().catch(() => {});
}

function buildDoc({ chrome, serversNote, error }) {
  const commit = (() => {
    try {
      return execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
    } catch {
      return "unknown";
    }
  })();

  const lines = [];
  lines.push("# Phase 2 — acceptance-criteria latency probe");
  lines.push("");
  lines.push("> Generated by `node scripts/phase2-latency-probe.mjs` (`pnpm probe:latency`).");
  lines.push("> Every number is labeled **measured** or **derived**. This file is committed with");
  lines.push(
    "> `git add -f` because `.gitignore` ignores `*.md`; the force-add is disclosed in the Phase 2 report.",
  );
  lines.push("");
  lines.push("## Environment");
  lines.push("");
  lines.push(`- Date: ${new Date().toISOString()}`);
  lines.push(`- Commit: ${commit}`);
  lines.push(`- Platform: ${process.platform} ${process.arch}`);
  lines.push(`- Browser: ${chrome ?? "not found"}`);
  lines.push(
    "- Mode: `VOICE_MOCK=true` (matches deployed `fly.toml`); mock STT/TTS/LLM, no provider calls",
  );
  lines.push(`- Services: ${serversNote}`);
  lines.push(
    '- Passes: "cold" = first page load in a fresh browser, "warm" = second load (separates dev-server cold-start cost from steady-state)',
  );
  lines.push(
    `- Local Postgres: not required for these paths (session falls back to an ephemeral id when the DB is absent)`,
  );
  lines.push("");
  if (error) {
    lines.push("## Run outcome");
    lines.push("");
    lines.push(`The probe did not complete fully: ${error}`);
    lines.push("");
  }
  lines.push("## Measured (real browser, headless Chrome with fake media devices)");
  lines.push("");
  lines.push("| Scenario | Result | Target | Notes |");
  lines.push("| --- | --- | --- | --- |");
  for (const m of measured) {
    lines.push(`| ${m.label} | ${m.ms} ms | ${m.target} | ${m.notes} |`);
  }
  if (measured.length === 0)
    lines.push("| (none) | — | — | probe recorded no scenarios this run |");
  lines.push("");
  lines.push("## Derived (from source constants, not measured in this run)");
  lines.push("");
  lines.push("| Quantity | Value | Source |");
  lines.push("| --- | --- | --- |");
  for (const d of derived) {
    lines.push(`| ${d.label} | ${d.value} | ${d.source} |`);
  }
  lines.push("");
  lines.push("## Attempts and fallbacks");
  lines.push("");
  if (attempts.length === 0) {
    lines.push("- (none)");
  }
  for (const a of attempts) {
    lines.push(`- \`${a.id}\` — ${a.label}: **${a.outcome}** — ${a.detail}`);
  }
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  lines.push(
    "- Anchors use a Node-side clock taken immediately before the puppeteer action; status polling runs in-page every 4 ms. Results include automation overhead (a few ms), biasing them high.",
  );
  lines.push(
    "- Cold-pass misses on mic-tap reflect first-request dev-server compilation in vite dev mode; the warm pass is the steady-state figure, and a production build serves pre-compiled assets with no per-request transform (derived).",
  );
  lines.push(
    "- Chrome's fake audio device content is unspecified; it was not driven with deliberate speech, so voice barge-in stays **derived** unless the app log excerpt shows an automatic VAD trigger (see Attempts).",
  );
  lines.push(
    "- Mock-mode timings say nothing about real STT/LLM/TTS latency; they measure this app's own pipeline (capture frames, FSM, Web Audio, WS plumbing).",
  );
  lines.push(
    "- Headless Chrome may throttle timers when idle; scenarios ran immediately after load.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  pushDerived();

  const chrome = findChrome();
  const owned = [];
  let error = null;
  let serversNote = "not started";

  if (!chrome) {
    error = "no Chrome/Chromium binary found (set CHROME_PATH); measured scenarios skipped";
    recordAttempt("chrome", "locate Chrome", "fallback", error);
  }

  if (!error) {
    try {
      const api = await ensureService(
        "api",
        `${API_ORIGIN}/health`,
        "pnpm",
        ["--filter", "@voice-agent/api", "dev"],
        { VOICE_MOCK: "true" },
      );
      if (api.owned) owned.push(api.proc);
      const web = await ensureService(
        "web",
        `${WEB_ORIGIN}/`,
        "pnpm",
        ["--filter", "@voice-agent/web", "dev"],
        {},
      );
      if (web.owned) owned.push(web.proc);
      serversNote = "api :3001 (health ok), web :5173 (ok)";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      recordAttempt("services", "start api + web", "fallback", error.split("\n")[0]);
      serversNote = "failed to start";
    }
  }

  if (!error) {
    const browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: [
        "--no-sandbox",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    try {
      PASS = "cold";
      await runScenarios(browser);
      PASS = "warm";
      await runScenarios(browser);
      PASS = "setup";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      recordAttempt("scenarios", "run browser scenarios", "fallback", error);
    } finally {
      await browser.close().catch(() => {});
    }
  }

  await mkdir(path.dirname(DOC_PATH), { recursive: true });
  await writeFile(DOC_PATH, buildDoc({ chrome, serversNote, error }), "utf8");

  for (const proc of owned) proc.kill();

  console.log(`probe: wrote ${path.relative(root, DOC_PATH)}`);
  for (const m of measured) console.log(`  measured ${m.id}: ${m.ms} ms (target ${m.target})`);
  for (const a of attempts.filter((x) => x.outcome !== "ok")) {
    console.log(`  ${a.outcome} ${a.id}: ${a.detail}`);
  }
  if (error) console.log(`  incomplete: ${error.split("\n")[0]}`);
}

try {
  await main();
} catch (err) {
  console.error("probe: fatal", err);
  process.exitCode = 1;
}

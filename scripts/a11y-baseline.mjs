import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!executablePath) {
  console.error("a11y: no Chrome/Chromium binary found (set CHROME_PATH).");
  process.exit(1);
}

const url = process.env.A11Y_URL ?? "http://localhost:4173/";

const browser = await puppeteer.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(url, { waitUntil: "load", timeout: 30_000 });
  await page.waitForSelector("main, #root", { timeout: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const results = await page.evaluate(async () => {
    const axe = window.axe;
    return axe.run(document, { resultTypes: ["violations"] });
  });

  await mkdir(path.join(root, "docs"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "docs", "a11y-baseline.png"),
    fullPage: true,
  });

  const violations = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => node.target),
  }));

  await writeFile(
    path.join(root, "docs", "a11y-baseline.json"),
    `${JSON.stringify({ url, violations }, null, 2)}\n`,
    "utf8",
  );

  console.log(`axe: ${violations.length} violation(s) on ${url}`);
  for (const violation of violations) {
    console.log(`- [${violation.impact}] ${violation.id}: ${violation.help}`);
    for (const target of violation.nodes) {
      console.log(`    ${target.join(" ")}`);
    }
  }

  process.exitCode = violations.length > 0 ? 1 : 0;
} finally {
  await browser.close();
}

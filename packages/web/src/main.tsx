// packages/web/src/main.tsx
// Day 1: prove shared-types import works from the browser package.

import { SHARED_TYPES_VERSION } from "@voice-agent/shared-types";

const root = document.getElementById("root");
if (root) {
  root.innerHTML = `
    <div style="font-family: system-ui; padding: 2rem; background: #0a0a0f; color: #e2e8f0; min-height: 100vh;">
      <h1>Voice Agent — Day 1</h1>
      <p>shared-types version: <code>${SHARED_TYPES_VERSION}</code></p>
      <p>Monorepo scaffold successful.</p>
    </div>
  `;
}
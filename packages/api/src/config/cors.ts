import { env } from "../env.js";

export function getCorsOrigin(): string | string[] | boolean {
  if (env.NODE_ENV === "development") {
    return ["http://localhost:5173", "http://127.0.0.1:5173"];
  }

  const raw = env.CORS_ORIGINS ?? "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (list.length === 0) return false;
  return list;
}

/**
 * CORS does not apply to WebSocket upgrades, so the audio socket checks the
 * Origin itself. Browsers always send it; a missing Origin is rejected too.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const allowed = getCorsOrigin();
  return Array.isArray(allowed) && allowed.includes(origin);
}

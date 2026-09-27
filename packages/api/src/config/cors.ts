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

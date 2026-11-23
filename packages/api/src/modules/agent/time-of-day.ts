// Greetings and sign-offs that fit the clock. Live bug: "have a great day"
// at 23:14. Applied to LLM replies only — tool replies (translations of
// "good morning") are data and are never rewritten.
import { ASSISTANT_TIME_ZONE } from "./gemini.tools.js";

export type PartOfDay = "morning" | "afternoon" | "evening" | "night";

/** 05–12 morning, 12–18 afternoon, 18–22 evening, 22–05 night (Stockholm). */
export function partOfDay(now: Date = new Date()): PartOfDay {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: ASSISTANT_TIME_ZONE,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

export const TIME_OF_DAY_PROMPT_RULE =
  '- Greetings and sign-offs must fit the current time above: no "have a great day" in the evening or at night (say "have a good evening" or "good night"), and "good morning" only in the morning. Usually no sign-off at all.';

const SIGN_OFF = /\b(have\s+a\s+)(?:great|nice|good|wonderful|lovely)\s+day\b/gi;
/**
 * An opening greeting used as a greeting ("Good morning!" / "Good morning,").
 * Not "Good morning." — that is more likely an answer ("god morgon" in English).
 */
const OPENING = /^(\s*)good\s+(?:morning|afternoon|evening)(?=\s*[!,])/i;
const OPENING_FOR: Record<PartOfDay, string> = {
  morning: "morning",
  afternoon: "afternoon",
  evening: "evening",
  night: "evening",
};

const keepCase = (original: string, replacement: string): string =>
  original.charAt(0) === original.charAt(0).toUpperCase()
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
    : replacement;

/**
 * Rewrites a sign-off or opening greeting that does not fit the time. Left
 * alone when the user used that greeting themselves (they may be quoting it).
 */
export function fitGreetingsToTime(
  reply: string,
  userText: string,
  now: Date = new Date(),
): string {
  const part = partOfDay(now);
  let out = reply;

  if (part === "evening" || part === "night") {
    const wish = part === "evening" ? "good evening" : "good night";
    out = out.replace(SIGN_OFF, (match: string, have: string) => keepCase(match, `${have}${wish}`));
  }

  const opening = out.match(OPENING);
  const userGreeted = /\bgood\s+(?:morning|afternoon|evening)\b/i.test(userText);
  if (opening && !userGreeted) {
    const fitting = `good ${OPENING_FOR[part]}`;
    const current = opening[0].trim();
    out = out.replace(OPENING, `${opening[1] ?? ""}${keepCase(current, fitting)}`);
  }
  return out;
}

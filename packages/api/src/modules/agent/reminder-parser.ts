import { ASSISTANT_TIME_ZONE } from "./gemini.tools.js";
import { normaliseSpokenTimes } from "./spoken-time.js";

const CLOCK = String.raw`\d{1,2}(?::\d{2})?\s*(?:am|pm)?`;
const SCHEDULE_PATTERN = new RegExp(
  String.raw`\b(?:(?:on\s+)?(?:tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+${CLOCK})?|at\s+${CLOCK}|\d{1,2}:\d{2}\s*(?:am|pm)?)\b`,
  "i",
);

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export type ReminderDetails = {
  note: string | null;
  time: string | null;
};

/**
 * Pattern parser: "Remind me at fourteen thirty to call mom" → note
 * "call mom", time "at 14:30". Used on its own in mock mode and as the
 * fallback when the LLM extraction is unavailable.
 */
export function extractReminderDetails(rawText: string): ReminderDetails {
  const text = normaliseSpokenTimes(rawText);
  const prefix = /\b(?:remind(?:er)?\s+(?:me\s+)?(?:to\s+)?|remember\s+to\s+)([\s\S]*)/i;
  const remainder = text.match(prefix)?.[1];
  if (!remainder) return { note: null, time: extractReminderTime(text) };

  const timeMatch = remainder.match(SCHEDULE_PATTERN);
  const time = timeMatch?.[0].replace(/^on\s+/i, "").trim() ?? null;
  const note = remainder
    .replace(SCHEDULE_PATTERN, " ")
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
    .replace(/^to\s+/i, "")
    .trim();

  return { note: note || null, time };
}

export function extractReminderTime(text: string): string | null {
  return (
    normaliseSpokenTimes(text)
      .match(SCHEDULE_PATTERN)?.[0]
      .replace(/^on\s+/i, "")
      .trim() ?? null
  );
}

type Zoned = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

/** Wall-clock parts of `date` in the assistant's time zone. */
function zonedParts(date: Date): Zoned {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ASSISTANT_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "long",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS.indexOf(get("weekday").toLowerCase()),
  };
}

/** The instant at which the Stockholm wall clock shows this date and time (DST-aware). */
function zonedToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wall;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(instant));
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    instant += wall - shown;
  }
  return new Date(instant);
}

/**
 * When a reminder is due, in Europe/Stockholm (the server runs in UTC on Fly).
 * "at 14:30" / "14:30" / "at 2:30 pm" / "tomorrow at 9" / "Monday" (09:00).
 * Null when no day or clock time is given.
 */
export function parseSchedule(timeText: string, now: Date = new Date()): Date | null {
  const lower = normaliseSpokenTimes(timeText).toLowerCase();
  const weekday = WEEKDAYS.findIndex((day) => new RegExp(`\\b${day}\\b`).test(lower));
  const tomorrow = /\btomorrow\b/.test(lower);
  const today = /\btoday\b/.test(lower);
  const clock =
    lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/) ??
    lower.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/);

  let hours = 9;
  let minutes = 0;
  if (clock) {
    hours = Number(clock[1]);
    minutes = clock[2] ? Number(clock[2]) : 0;
    if (clock[3] === "pm" && hours < 12) hours += 12;
    if (clock[3] === "am" && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return null;
  } else if (!tomorrow && !today && weekday < 0) {
    return null;
  }

  const local = zonedParts(now);
  let daysAhead = 0;
  if (tomorrow) {
    daysAhead = 1;
  } else if (weekday >= 0) {
    daysAhead = (weekday - local.weekday + 7) % 7 || 7;
  } else if (!today && clock && hours * 60 + minutes <= local.hour * 60 + local.minute) {
    daysAhead = 1; // already past today
  }

  const target = new Date(Date.UTC(local.year, local.month - 1, local.day + daysAhead));
  return zonedToInstant(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    hours,
    minutes,
  );
}

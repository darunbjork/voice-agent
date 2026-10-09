const SCHEDULE_PATTERN =
  /\b(?:(?:on\s+)?(?:tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export type ReminderDetails = {
  note: string | null;
  time: string | null;
};

export function extractReminderDetails(text: string): ReminderDetails {
  const prefix = /\b(?:remind(?:er)?\s+(?:me\s+)?(?:to\s+)?|remember\s+to\s+)([\s\S]*)/i;
  const remainder = text.match(prefix)?.[1];
  if (!remainder) return { note: null, time: extractReminderTime(text) };

  const timeMatch = remainder.match(SCHEDULE_PATTERN);
  const time = timeMatch?.[0].replace(/^on\s+/i, "").trim() ?? null;
  const note = remainder
    .replace(SCHEDULE_PATTERN, " ")
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
    .trim();

  return { note: note || null, time };
}

export function extractReminderTime(text: string): string | null {
  return (
    text
      .match(SCHEDULE_PATTERN)?.[0]
      .replace(/^on\s+/i, "")
      .trim() ?? null
  );
}

export function parseSchedule(timeText: string, now: Date = new Date()): Date | null {
  const lower = timeText.toLowerCase();
  const weekday = WEEKDAYS.findIndex((day) => new RegExp(`\\b${day}\\b`).test(lower));
  const hasDay = /\btomorrow\b/.test(lower) || /\btoday\b/.test(lower) || weekday >= 0;
  const timeMatch = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);

  let hours = 9;
  let minutes = 0;
  if (timeMatch) {
    hours = Number(timeMatch[1]);
    minutes = timeMatch[2] ? Number(timeMatch[2]) : 0;
    if (timeMatch[3] === "pm" && hours < 12) hours += 12;
    if (timeMatch[3] === "am" && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return null;
  } else if (!hasDay) {
    return null;
  }

  const base = new Date(now);
  base.setSeconds(0, 0);
  if (/\btomorrow\b/.test(lower)) {
    base.setDate(base.getDate() + 1);
  } else if (weekday >= 0) {
    const daysAhead = (weekday - base.getDay() + 7) % 7 || 7;
    base.setDate(base.getDate() + daysAhead);
  } else if (!/\btoday\b/.test(lower) && timeMatch) {
    const candidate = new Date(base);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() <= now.getTime()) base.setDate(base.getDate() + 1);
  }

  base.setHours(hours, minutes, 0, 0);
  return base;
}

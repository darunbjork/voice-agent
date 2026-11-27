import { ASSISTANT_TIME_ZONE } from "./gemini.tools.js";
import { normaliseSpokenTimes } from "./spoken-time.js";

const CLOCK = String.raw`\d{1,2}(?::\d{2})?\s*(?:am|pm)?`;
const DAY = String.raw`(?:tomorrow|today|tonight|this\s+evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)`;
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const AMOUNT = String.raw`(?:\d+|half\s+an|${Object.keys(NUMBER_WORDS).join("|")})`;
/** "in 2 hours", "in two hours", "in 30 minutes", "in half an hour". */
const DURATION = String.raw`in\s+${AMOUNT}\s+(?:hours?|minutes?|mins?)`;
const SCHEDULE_PATTERN = new RegExp(
  String.raw`\b(?:${DURATION}|(?:(?:on|next)\s+)?${DAY}(?:\s+at\s+${CLOCK})?|at\s+${CLOCK}|\d{1,2}:\d{2}\s*(?:am|pm)?)\b`,
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

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = WEEKDAYS.map((d) => d[0]!.toUpperCase() + d.slice(1));
const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Default time for a day without a clock time, and for "tonight". */
const DEFAULT_HOUR = 9;
const TONIGHT_HOUR = 20;

export type ReminderWhen = {
  /** The due instant; null for "today" / "later today" without a clock time. */
  at: Date | null;
  /** Card and storage: "Sat 28 Nov" or "Sat 28 Nov, 15:00" (Europe/Stockholm). */
  display: string;
  /** Spoken reply: "tomorrow, Saturday 28 November" (the words said, then the date). */
  spoken: string;
};

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * Resolves what the user said ("tomorrow", "tomorrow at 3", "next Monday",
 * "on Friday", "in 2 hours", "tonight", "at 17:30") to an absolute date and
 * time in Europe/Stockholm (the server runs in UTC on Fly), DST-aware. Done
 * in code, never by the LLM. Null when the text names no day, clock time or
 * duration ("later today", "in a while").
 *
 * - A bare hour 1–6 without am/pm or minutes is the afternoon ("at 3" →
 *   15:00); "tonight at 9" → 21:00. "03:00" with a leading zero stays 03:00.
 * - A day without a clock time is due at 09:00 and shown as a date only;
 *   "tonight" is 20:00.
 * - A weekday is the next one ("on Friday" said on a Friday → next week).
 * - A clock time already past today (no day given) is tomorrow.
 */
export function resolveReminderWhen(timeText: string, now: Date = new Date()): ReminderWhen | null {
  const lower = normaliseSpokenTimes(timeText).toLowerCase().replace(/\s+/g, " ").trim();

  const duration = lower.match(
    new RegExp(String.raw`\bin\s+(\d+|half\s+an|[a-z]+)\s+(hours?|minutes?|mins?)\b`),
  );
  if (duration) {
    const amountText = duration[1]!;
    const amount = /^half\s+an$/.test(amountText)
      ? 0.5
      : /^\d+$/.test(amountText)
        ? Number(amountText)
        : NUMBER_WORDS[amountText];
    if (amount === undefined || amount <= 0) return null;
    const unitMs = duration[2]!.startsWith("hour") ? 3_600_000 : 60_000;
    const at = new Date(now.getTime() + amount * unitMs);
    const due = zonedParts(at);
    const today = zonedParts(now);
    const sameDay = due.year === today.year && due.month === today.month && due.day === today.day;
    const clock = `${pad(due.hour)}:${pad(due.minute)}`;
    return {
      at,
      display: `${shortDate(due)}, ${clock}`,
      spoken: `${duration[0]}, at ${clock}${sameDay ? "" : ` on ${longDate(due, true)}`}`,
    };
  }

  const weekday = WEEKDAYS.findIndex((day) => new RegExp(`\\b${day}\\b`).test(lower));
  const next = weekday >= 0 && new RegExp(`\\bnext\\s+${WEEKDAYS[weekday]}\\b`).test(lower);
  const tomorrow = /\btomorrow\b/.test(lower);
  const tonight = /\btonight\b|\bthis evening\b/.test(lower);
  const today = /\btoday\b/.test(lower);
  const clock =
    lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/) ??
    lower.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/);

  // "later today" / "today" with no clock time: today's date, no due time
  // (09:00 would often be in the past).
  if (today && !clock && !tomorrow && !tonight && weekday < 0) {
    const local = zonedParts(now);
    return {
      at: null,
      display: shortDate(local),
      spoken: `${/\blater today\b/.test(lower) ? "later today" : "today"}, ${longDate(local, true)}`,
    };
  }

  let hours = tonight ? TONIGHT_HOUR : DEFAULT_HOUR;
  let minutes = 0;
  if (clock) {
    hours = Number(clock[1]);
    minutes = clock[2] ? Number(clock[2]) : 0;
    const meridiem = clock[3];
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    const bareHour = !meridiem && !clock[1]!.startsWith("0") && (!clock[2] || clock[2] === "00");
    if (bareHour && (tonight ? hours < 12 : hours >= 1 && hours <= 6)) hours += 12;
    if (hours > 23 || minutes > 59) return null;
  } else if (!tomorrow && !today && !tonight && weekday < 0) {
    return null;
  }

  const local = zonedParts(now);
  let daysAhead = 0;
  if (tomorrow) {
    daysAhead = 1;
  } else if (weekday >= 0) {
    daysAhead = (weekday - local.weekday + 7) % 7 || 7;
  } else if (
    !today &&
    !tonight &&
    clock &&
    hours * 60 + minutes <= local.hour * 60 + local.minute
  ) {
    daysAhead = 1; // already past today
  }

  const target = new Date(Date.UTC(local.year, local.month - 1, local.day + daysAhead));
  const at = zonedToInstant(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    hours,
    minutes,
  );
  const due = zonedParts(at);
  const showClock = Boolean(clock) || tonight;
  const clockText = `${pad(due.hour)}:${pad(due.minute)}`;

  const said = tonight
    ? "tonight"
    : tomorrow
      ? "tomorrow"
      : weekday >= 0
        ? `${next ? "next" : "on"} ${WEEKDAY_LONG[weekday]}`
        : daysAhead === 0
          ? "today"
          : "tomorrow";
  return {
    at,
    display: showClock ? `${shortDate(due)}, ${clockText}` : shortDate(due),
    spoken: `${said}, ${longDate(due, weekday < 0)}${showClock ? `, at ${clockText}` : ""}`,
  };
}

/** "Sat 28 Nov" */
function shortDate(d: Zoned): string {
  return `${WEEKDAY_SHORT[d.weekday]} ${d.day} ${MONTH_SHORT[d.month - 1]}`;
}

/** "Saturday 28 November", or "28 November" when the weekday was already said. */
function longDate(d: Zoned, withWeekday: boolean): string {
  const date = `${d.day} ${MONTH_LONG[d.month - 1]}`;
  return withWeekday ? `${WEEKDAY_LONG[d.weekday]} ${date}` : date;
}

/**
 * When a reminder is due, in Europe/Stockholm. Null when no day, clock time
 * or duration is given. See resolveReminderWhen.
 */
export function parseSchedule(timeText: string, now: Date = new Date()): Date | null {
  return resolveReminderWhen(timeText, now)?.at ?? null;
}

// Day counts ("How many days until New Year?") computed in code, in the
// assistant's time zone. Live bug: the LLM answered 40 on 21 November; the
// right answer is 41. Anything not recognised here returns null and goes to
// the model as before.
import { ASSISTANT_TIME_ZONE } from "./gemini.tools.js";

type CalendarDate = { year: number; month: number; day: number };

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;
const MONTH_NAMES = MONTHS.map((m) => m.charAt(0).toUpperCase() + m.slice(1));
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Fixed-date holidays: [label, month (1-12), day]. */
const HOLIDAYS: Array<{ re: RegExp; label: string; month: number; day: number }> = [
  { re: /^new\s+year'?s?\s+eve$/, label: "New Year's Eve", month: 12, day: 31 },
  { re: /^(?:the\s+)?new\s+year'?s?(?:\s+day)?$/, label: "New Year's Day", month: 1, day: 1 },
  { re: /^christmas\s+eve$/, label: "Christmas Eve", month: 12, day: 24 },
  { re: /^(?:christmas|xmas)(?:\s+day)?$/, label: "Christmas Day", month: 12, day: 25 },
  { re: /^boxing\s+day$/, label: "Boxing Day", month: 12, day: 26 },
  { re: /^hallowe'?en$/, label: "Halloween", month: 10, day: 31 },
  { re: /^valentine'?s?(?:\s+day)?$/, label: "Valentine's Day", month: 2, day: 14 },
];

const QUESTION =
  /^(?:so\s+|and\s+)?(?:how\s+many\s+(days|weeks)\s+(?:are\s+)?(?:there\s+)?(?:left\s+)?|how\s+long\s+(?:is\s+it\s+)?|(days|weeks)\s+(?:left\s+)?)(?:until|till|til|to|before)\s+(.+?)\s*[?.!]*$/i;

/** Today's calendar date in the assistant's time zone. */
function today(now: Date): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ASSISTANT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

const dayNumber = (d: CalendarDate): number => Date.UTC(d.year, d.month - 1, d.day) / 86_400_000;

function isValid(d: CalendarDate): boolean {
  const probe = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return probe.getUTCMonth() === d.month - 1 && probe.getUTCDate() === d.day;
}

/** The next date (today or later) with this month and day. */
function nextOccurrence(from: CalendarDate, month: number, day: number): CalendarDate | null {
  for (const year of [from.year, from.year + 1, from.year + 4]) {
    const candidate = { year, month, day };
    if (isValid(candidate) && dayNumber(candidate) >= dayNumber(from)) return candidate;
  }
  return null;
}

function parseMonth(word: string): number | null {
  const w = word.toLowerCase();
  const i = MONTHS.findIndex((m) => m === w || (w.length >= 3 && m.startsWith(w)));
  return i >= 0 ? i + 1 : null;
}

/** "December 31st", "31 December", "the 5th of March". */
function parseExplicitDate(target: string): { month: number; day: number } | null {
  const t = target.replace(/^the\s+/i, "");
  const monthFirst = t.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/i);
  const dayFirst = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)$/i);
  const [monthWord, dayText] = monthFirst
    ? [monthFirst[1], monthFirst[2]]
    : dayFirst
      ? [dayFirst[2], dayFirst[1]]
      : [undefined, undefined];
  if (!monthWord || !dayText) return null;
  const month = parseMonth(monthWord);
  const day = Number(dayText);
  return month && day >= 1 && day <= 31 ? { month, day } : null;
}

function resolveTarget(
  rawTarget: string,
  from: CalendarDate,
): { date: CalendarDate; label: string } | null {
  const target = rawTarget.trim().toLowerCase().replace(/\s+/g, " ");

  const holiday = HOLIDAYS.find((h) => h.re.test(target));
  if (holiday) {
    const date = nextOccurrence(from, holiday.month, holiday.day);
    return date ? { date, label: holiday.label } : null;
  }

  const weekday = WEEKDAYS.indexOf(target.replace(/^(?:next\s+|this\s+)/, ""));
  if (weekday >= 0) {
    const fromWeekday = new Date(Date.UTC(from.year, from.month - 1, from.day)).getUTCDay();
    const ahead = (weekday - fromWeekday + 7) % 7 || 7;
    const d = new Date(Date.UTC(from.year, from.month - 1, from.day + ahead));
    return {
      date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() },
      label: WEEKDAYS[weekday]!.charAt(0).toUpperCase() + WEEKDAYS[weekday]!.slice(1),
    };
  }

  const explicit = parseExplicitDate(target);
  if (explicit) {
    const date = nextOccurrence(from, explicit.month, explicit.day);
    return date ? { date, label: `${explicit.day} ${MONTH_NAMES[explicit.month - 1]}` } : null;
  }
  return null;
}

function longDate(d: CalendarDate): string {
  const weekday = new Date(Date.UTC(d.year, d.month - 1, d.day)).toLocaleDateString("en-GB", {
    weekday: "long",
    timeZone: "UTC",
  });
  return `${weekday}, ${d.day} ${MONTH_NAMES[d.month - 1]} ${d.year}`;
}

/** The spoken answer to a "how many days until …" question, or null. */
export function dateAnswer(text: string, now: Date = new Date()): string | null {
  const m = text.trim().match(QUESTION);
  if (!m?.[3]) return null;
  const wantsWeeks = (m[1] ?? m[2] ?? "").toLowerCase() === "weeks";

  const from = today(now);
  const target = resolveTarget(m[3], from);
  if (!target) return null;

  const days = dayNumber(target.date) - dayNumber(from);
  const when = longDate(target.date);
  if (days === 0) return `${target.label} is today (${when}).`;

  const weeks = Math.floor(days / 7);
  const rest = days % 7;
  const weekPart =
    wantsWeeks && weeks > 0
      ? ` (${weeks} week${weeks === 1 ? "" : "s"}${rest ? ` and ${rest} day${rest === 1 ? "" : "s"}` : ""})`
      : "";
  const count = days === 1 ? "is 1 day" : `are ${days} days`;
  return `There ${count}${weekPart} until ${target.label} (${when}).`;
}

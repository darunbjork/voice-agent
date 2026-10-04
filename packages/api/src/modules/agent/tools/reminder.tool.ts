import type { ReminderCard } from "@voice-agent/shared-types";
import { env } from "../../../env.js";
import { getPrisma } from "../../../utils/db.js";

export type ReminderToolInput = {
  userText: string;
  slots: Record<string, string>;
};

export type ReminderToolResult = {
  card: ReminderCard;
  replyHint: string;
};

export async function reminderTool(input: ReminderToolInput): Promise<ReminderToolResult> {
  const note = input.slots.note?.trim() || extractNote(input.userText) || "your task";
  const time = input.slots.time?.trim() || extractTime(input.userText) || "later today";

  const card: ReminderCard = { type: "reminder", note, time };

  if (env.VOICE_MOCK) {
    return {
      card,
      replyHint: `Okay, I will remind you to ${note} ${time}.`,
    };
  }

  try {
    await getPrisma().reminder.create({
      data: {
        note,
        timeText: time,
        scheduledAt: parseSchedule(time),
      },
    });
  } catch {
    // DB down or table missing — stay honest instead of claiming it was saved.
    return {
      card,
      replyHint: `I could not save the reminder to ${note} ${time}. Please try again.`,
    };
  }

  return {
    card,
    replyHint: `Okay, I will remind you to ${note} ${time}.`,
  };
}

function extractNote(text: string): string | null {
  const m = text.match(
    /\b(?:remind(?:er)?\s+(?:me\s+)?(?:to\s+)?|remember\s+to\s+)(.+?)(?:\s+at\s+|\s+tomorrow|\s+today|$)/i,
  );
  return m?.[1]?.trim() ?? null;
}

function extractTime(text: string): string | null {
  const m = text.match(
    /\b(tomorrow(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?|today(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
  );
  return m?.[1]?.trim() ?? null;
}

/**
 * Best-effort parse of phrases like "tomorrow", "tomorrow at 5pm",
 * "today at 09:30", "at 5pm" into a Date. Returns null when no
 * schedule can be derived (e.g. "later today").
 */
export function parseSchedule(timeText: string, now: Date = new Date()): Date | null {
  const lower = timeText.toLowerCase();

  const hasDay = /\btomorrow\b/.test(lower) || /\btoday\b/.test(lower);
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
  } else if (!/\btoday\b/.test(lower) && timeMatch) {
    // Bare "at 5pm" — today if still ahead, otherwise tomorrow.
    const candidate = new Date(base);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() <= now.getTime()) base.setDate(base.getDate() + 1);
  }

  base.setHours(hours, minutes, 0, 0);
  return base;
}

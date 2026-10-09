import type { ReminderCard } from "@voice-agent/shared-types";
import { env } from "../../../env.js";
import { getPrisma } from "../../../utils/db.js";
import { extractReminderDetails, parseSchedule } from "../reminder-parser.js";

export { parseSchedule } from "../reminder-parser.js";

export type ReminderToolInput = {
  userText: string;
  slots: Record<string, string>;
};

export type ReminderToolResult = {
  card: ReminderCard;
  replyHint: string;
};

export async function reminderTool(input: ReminderToolInput): Promise<ReminderToolResult> {
  const extracted = extractReminderDetails(input.userText);
  const note = extracted.note || input.slots.note?.trim() || "your task";
  const time = extracted.time || input.slots.time?.trim() || "later today";

  const card: ReminderCard = { type: "reminder", note, time };

  if (env.VOICE_MOCK) {
    return {
      card,
      replyHint: `Demo mode: I would ${reminderAction(note, time)}, but this reminder was not saved.`,
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
    replyHint: `Okay, I will ${reminderAction(note, time)}.`,
  };
}

function reminderAction(note: string, time: string): string {
  if (/^(?:I|we|you|they)\b/i.test(note)) {
    return `remind you ${time} that ${note}`;
  }
  return `remind you to ${note} ${time}`;
}

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
      replyHint: `Demo mode: this reminder was not saved: ${reminderSummary(note, time)}. ${NO_ALERTS}`,
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
    replyHint: `I saved a reminder ${reminderSummary(note, time)}. ${NO_ALERTS}`,
  };
}

/**
 * A saved reminder is a note: there is no scheduler and no push notification,
 * so nothing fires at the due time. Never promise that it will.
 */
const NO_ALERTS = "I can't send notifications, so nothing will alert you when it is due.";

function reminderSummary(note: string, time: string): string {
  if (/^(?:I|we|you|they)\b/i.test(note)) {
    return `that ${note}, ${time}`;
  }
  return `to ${note} ${time}`;
}

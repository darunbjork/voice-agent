import type { ReminderCard } from "@voice-agent/shared-types";
import { env } from "../../../env.js";
import { getPrisma } from "../../../utils/db.js";
import { resolveReminderWhen } from "../reminder-parser.js";
import { extractReminder } from "../reminder-extract.js";

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
  // Structured output {task, time} live; the pattern parser in mock mode.
  const extracted = await extractReminder(input.userText);
  const note = extracted.note || input.slots.note?.trim() || "your task";
  const said = extracted.time || input.slots.time?.trim() || "later today";

  // C11: "tomorrow" is resolved here, in code, to an absolute Stockholm date.
  // Card and database get the date ("Sat 28 Nov, 15:00"), which stays right
  // the day after; the reply keeps the words said ("tomorrow, Saturday 28
  // November"). A time that cannot be resolved is kept as said, undated.
  const when = resolveReminderWhen(said);
  const shown = when?.display ?? said;
  const spoken = when?.spoken ?? said;

  const card: ReminderCard = { type: "reminder", note, time: shown };

  if (env.VOICE_MOCK) {
    return {
      card,
      replyHint: `Demo mode: this reminder was not saved: ${reminderSummary(note, spoken)}. ${NO_ALERTS}`,
    };
  }

  try {
    await getPrisma().reminder.create({
      data: {
        note,
        timeText: shown,
        scheduledAt: when?.at ?? null,
      },
    });
  } catch {
    // DB down or table missing — stay honest instead of claiming it was saved.
    return {
      card,
      replyHint: `I could not save the reminder to ${note} ${spoken}. Please try again.`,
    };
  }

  return {
    card,
    replyHint: `I saved a reminder ${reminderSummary(note, spoken)}. ${NO_ALERTS}`,
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

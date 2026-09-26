import type { ReminderCard } from "@voice-agent/shared-types";

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

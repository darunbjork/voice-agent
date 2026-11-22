// Reminders are saved notes. Nothing fires at the due time (no scheduler, no
// push notifications), so the agent must never promise to remind or notify.
// Live bug: reminders for 14:13 and 14:15 never fired after
// "Okay, I will remind you to …".
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { env } from "../env.js";
import { reminderTool } from "../modules/agent/tools/reminder.tool.js";
import { helpTool } from "../modules/agent/tools/help.tool.js";
import { SYSTEM_PROMPT } from "../modules/agent/gemini.service.js";
import { closePrisma } from "../utils/db.js";

/** Any wording that promises a future alert. */
const PROMISE =
  /\b(?:I will|I'll|we will|we'll|I would)\s+(?:remind|notify|alert|ping)\b|\byou(?:'ll| will)\s+(?:get|receive|be (?:notified|alerted|reminded))\b/i;

it("the promise detector catches the old wording and passes the honest one", () => {
  expect("Okay, I will remind you to water the plants tomorrow.").toMatch(PROMISE);
  expect("Demo mode: I would remind you to call, but it was not saved.").toMatch(PROMISE);
  expect("You will be notified at 5 pm.").toMatch(PROMISE);
  expect("I can't send notifications, so nothing will alert you when it is due.").not.toMatch(
    PROMISE,
  );
});

const originalMock = env.VOICE_MOCK;
afterEach(() => {
  env.VOICE_MOCK = originalMock;
});
afterAll(async () => {
  await closePrisma();
});

describe("reminders never promise a notification", () => {
  it.each([
    "Remind me to water the plants tomorrow",
    "Remind me at 14:13 to stretch",
    "Remind me on Monday, I have a meeting",
  ])('saved reminder "%s" says it was saved and that nothing will alert', async (text) => {
    env.VOICE_MOCK = false; // real save to the local test database
    const r = await reminderTool({ userText: text, slots: {} });
    expect(r.replyHint).toMatch(/^I saved a reminder/);
    expect(r.replyHint).toContain("can't send notifications");
    expect(r.replyHint).not.toMatch(PROMISE);
  });

  it("demo mode says it was not saved and makes no promise", async () => {
    env.VOICE_MOCK = true;
    const r = await reminderTool({ userText: "Remind me to call the recruiter at 3pm", slots: {} });
    expect(r.replyHint).toContain("this reminder was not saved");
    expect(r.replyHint).not.toMatch(PROMISE);
  });

  it("the help card says reminders do not alert", async () => {
    env.VOICE_MOCK = false;
    const r = await helpTool();
    const reminder = r.card.commands.find((c) => c.name === "reminder");
    expect(reminder?.description).toMatch(/no alerts/i);
  });

  it("the system prompt forbids promising notifications", () => {
    expect(SYSTEM_PROMPT).toContain("cannot notify or alert the user");
    expect(SYSTEM_PROMPT).toMatch(/never promise/i);
  });
});

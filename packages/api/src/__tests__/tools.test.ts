import { describe, it, expect } from "vitest";
import { weatherTool } from "../modules/agent/tools/weather.tool.js";
import { reminderTool } from "../modules/agent/tools/reminder.tool.js";
import { translateTool } from "../modules/agent/tools/translate.tool.js";
import { summarizeTool } from "../modules/agent/tools/summarize.tool.js";
import { helpTool } from "../modules/agent/tools/help.tool.js";
import { runTool, listRegisteredIntents } from "../modules/agent/tool.registry.js";
import { classifyByKeywords } from "../modules/agent/intent.classifier.js";

describe("tool handlers", () => {
  it("weather returns a weather card with the requested location", async () => {
    const r = await weatherTool({
      userText: "What is the weather in Berlin?",
      slots: { location: "Berlin" },
    });
    expect(r.card.type).toBe("weather");
    expect(r.card.location).toBe("Berlin");
    expect(r.replyHint.toLowerCase()).toContain("berlin");
  });

  it("weather falls back to Stockholm when no slot", async () => {
    const r = await weatherTool({ userText: "weather?", slots: {} });
    expect(r.card.location).toBe("Stockholm");
  });

  it("reminder extracts note", async () => {
    const r = await reminderTool({
      userText: "Remind me to call the recruiter tomorrow",
      slots: {},
    });
    expect(r.card.type).toBe("reminder");
    expect(r.card.note.toLowerCase()).toContain("call the recruiter");
    expect(r.card.time.toLowerCase()).toContain("tomorrow");
  });

  it("translate uses demo dictionary and reports hit", async () => {
    const r = await translateTool({
      userText: "Translate hello world in swedish",
      slots: { original: "hello world", toLang: "sv" },
    });
    expect(r.card.type).toBe("translate");
    expect(r.card.translated.toLowerCase()).toContain("hej");
    expect(r.replyHint).toContain("Swedish");
  });

  it("translate falls back honestly when not in dictionary", async () => {
    const r = await translateTool({
      userText: "Translate quantum chromodynamics in swedish",
      slots: { original: "quantum chromodynamics", toLang: "sv" },
    });
    expect(r.card.translated).not.toMatch(/^\[/);
    expect(r.replyHint).toContain("do not have a translation");
  });

  it("translate uses the asked word for 'what does X mean in <lang>'", async () => {
    const text = "What does the word high mean in Swedish?";
    const fast = classifyByKeywords(text);
    expect(fast?.intent).toBe("translate");
    const r = await translateTool({ userText: text, slots: fast?.slots ?? {} });
    expect(r.card.original.toLowerCase()).toBe("high");
    expect(r.replyHint.toLowerCase()).toContain("high");
  });

  it("translate extracts the original from meaning questions without slots", async () => {
    const r = await translateTool({
      userText: "What dose good-bye mean in Swedish?",
      slots: {},
    });
    expect(r.card.original.toLowerCase()).toBe("good-bye");
    expect(r.card.original.toLowerCase()).not.toBe("hello");
  });

  it("translate extracts the original when 'what' is missing from the transcript", async () => {
    const r = await translateTool({
      userText: "Does the word high mean in Swedish?",
      slots: {},
    });
    expect(r.card.original.toLowerCase()).toBe("high");
    expect(r.card.original.toLowerCase()).not.toBe("hello");
  });

  it("summarize returns at least 2 points for multi-sentence input", async () => {
    const r = await summarizeTool({
      userText: "First point. Second point. Third point.",
      slots: {},
    });
    expect(r.card.type).toBe("summary");
    expect(r.card.points.length).toBeGreaterThanOrEqual(2);
  });

  it("help returns at least 4 commands", async () => {
    const r = await helpTool();
    expect(r.card.type).toBe("help");
    expect(r.card.commands.length).toBeGreaterThanOrEqual(4);
  });

  it("registry runs the correct tool", async () => {
    const r = await runTool("weather", {
      userText: "weather in Oslo",
      slots: { location: "Oslo" },
    });
    expect(r.card?.type).toBe("weather");
  });

  it("registry lists all tool intents", () => {
    const intents = listRegisteredIntents();
    expect(intents).toEqual(
      expect.arrayContaining(["weather", "reminder", "translate", "summarize", "help"]),
    );
  });

  it("fallback has no tool and returns null", async () => {
    const r = await runTool("fallback", { userText: "xyz", slots: {} });
    expect(r.card).toBeNull();
    expect(r.replyHint).toBeNull();
  });

  it("reminder does not duplicate the trailing time word", async () => {
    const text = "Remind me to follow up with the recruiter tomorrow";
    const fast = classifyByKeywords(text);
    expect(fast?.intent).toBe("reminder");
    const r = await reminderTool({ userText: text, slots: fast?.slots ?? {} });
    expect(r.replyHint).not.toMatch(/tomorrow.*tomorrow/i);
    expect(r.card.note.toLowerCase()).not.toMatch(/tomorrow$/);
    expect(r.card.time.toLowerCase()).toBe("tomorrow");
  });

  it("reminder stops the note before an at-time", async () => {
    const text = "Remind me to call Alex at 5pm";
    const fast = classifyByKeywords(text);
    expect(fast?.intent).toBe("reminder");
    const r = await reminderTool({ userText: text, slots: fast?.slots ?? {} });
    expect(r.card.note).toBe("call Alex");
    expect(r.card.time).toBe("at 5pm");
  });

  it("summarize strips the command prefix from points and source", async () => {
    const r = await summarizeTool({
      userText: "Summarize: we shipped the API, fixed the tests, and wrote the docs.",
      slots: {},
    });
    expect(r.card.points[0]).not.toMatch(/^summarize/i);
    expect(r.card.source).not.toMatch(/^summarize/i);
    expect(r.card.points.length).toBeGreaterThanOrEqual(3);
  });

  it("summarize strips the Recap: prefix", async () => {
    const r = await summarizeTool({ userText: "Recap: one. two. three.", slots: {} });
    expect(r.card.points[0]).not.toMatch(/^recap/i);
    expect(r.card.source).not.toMatch(/^recap/i);
    expect(r.card.points.length).toBeGreaterThanOrEqual(3);
  });

  it("summarize strips a leading please", async () => {
    const r = await summarizeTool({ userText: "please summarize: alpha, beta", slots: {} });
    expect(r.card.points[0]).toBe("alpha");
  });

  it("help has no hardcoded example names", async () => {
    const r = await helpTool();
    for (const cmd of r.card.commands) {
      expect(cmd.description).not.toMatch(/alex|stockholm/i);
    }
  });
});

import { describe, it, expect } from "vitest";
import { weatherTool } from "../modules/agent/tools/weather.tool.js";
import { reminderTool } from "../modules/agent/tools/reminder.tool.js";
import { translateTool } from "../modules/agent/tools/translate.tool.js";
import { summarizeTool } from "../modules/agent/tools/summarize.tool.js";
import { helpTool } from "../modules/agent/tools/help.tool.js";
import { runTool, listRegisteredIntents } from "../modules/agent/tool.registry.js";

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
});

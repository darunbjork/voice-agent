import type { IntentType, ResponseCard } from "@voice-agent/shared-types";
import { weatherTool } from "./tools/weather.tool.js";
import { reminderTool } from "./tools/reminder.tool.js";
import { translateTool } from "./tools/translate.tool.js";
import { summarizeTool } from "./tools/summarize.tool.js";
import { helpTool } from "./tools/help.tool.js";

export type ToolInput = {
  userText: string;
  slots: Record<string, string>;
};

export type ToolResult = {
  card: ResponseCard | null;
  replyHint: string | null;
};

export type ToolHandler = (input: ToolInput) => Promise<ToolResult>;

const registry: Partial<Record<IntentType, ToolHandler>> = {
  weather: async (input) => weatherTool(input),
  reminder: async (input) => reminderTool(input),
  translate: async (input) => translateTool(input),
  summarize: async (input) => summarizeTool(input),
  help: async () => helpTool(),
};

export async function runTool(intent: IntentType, input: ToolInput): Promise<ToolResult> {
  const handler = registry[intent];
  if (!handler) return { card: null, replyHint: null };
  return handler(input);
}

export function listRegisteredIntents(): IntentType[] {
  return Object.keys(registry) as IntentType[];
}

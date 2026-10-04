import type { HelpCard } from "@voice-agent/shared-types";

export type HelpToolResult = {
  card: HelpCard;
  replyHint: string;
};

const COMMANDS: HelpCard["commands"] = [
  {
    name: "weather",
    description: 'Current weather for a city (e.g. "weather in London")',
  },
  {
    name: "reminder",
    description: 'Set a quick reminder (e.g. "remind me to call the recruiter")',
  },
  {
    name: "translate",
    description: 'Translate a short phrase (e.g. "translate hello in swedish")',
  },
  {
    name: "summarize",
    description: "Summarize what you just said into bullet points",
  },
  { name: "help", description: "List available commands" },
];

export async function helpTool(): Promise<HelpToolResult> {
  return {
    card: { type: "help", commands: COMMANDS },
    replyHint: "I can help with weather, reminders, translation, and summaries. What do you need?",
  };
}

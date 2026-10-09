import type { HelpCard } from "@voice-agent/shared-types";
import { env } from "../../../env.js";

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
    description: env.VOICE_MOCK
      ? "Preview a reminder (not saved while demo mode is on)"
      : 'Save a reminder (e.g. "remind me to call the recruiter")',
  },
  {
    name: "translate",
    description: env.VOICE_MOCK
      ? 'Translate sample phrases (e.g. "translate hello in swedish")'
      : 'Translate a short phrase (e.g. "translate hello in swedish")',
  },
  {
    name: "summarize",
    description: env.VOICE_MOCK
      ? "Split what you said into basic bullet points"
      : "Summarize what you just said into bullet points",
  },
  { name: "help", description: "List available commands" },
];

export async function helpTool(): Promise<HelpToolResult> {
  return {
    card: { type: "help", commands: COMMANDS },
    replyHint: env.VOICE_MOCK
      ? "Demo mode is on: microphone input uses a sample transcript, weather is live, translations use sample phrases, summaries use a basic splitter, and reminders are not saved. What do you need?"
      : "I can help with weather, reminders, translation, and summaries. What do you need?",
  };
}

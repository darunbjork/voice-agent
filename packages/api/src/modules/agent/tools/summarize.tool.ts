import type { SummaryCard } from "@voice-agent/shared-types";
import { env } from "../../../env.js";
import { generateToolText } from "../gemini.tools.js";

export type SummarizeToolInput = {
  userText: string;
  slots: Record<string, string>;
};

export type SummarizeToolResult = {
  card: SummaryCard;
  replyHint: string;
};

const SUMMARIZE_SYSTEM_PROMPT =
  "You turn spoken input into short bullet points. " +
  "Reply with at most 5 lines, each line one point. " +
  "No numbering, no bullet characters, no preamble, no commentary.";

function stripCommandPrefix(text: string): string {
  return text
    .replace(/^\s*(?:please\s+)?(?:summarize|summarise|summary|recap|tldr|tl;dr)\s*[:-]?\s*/i, "")
    .trim();
}

const CONVERSATION_SYSTEM_PROMPT =
  "You summarize a conversation between a user and a voice assistant into its key points. " +
  "Cover what the user asked and what they learned. " +
  "Reply with at most 5 lines, each line one point. " +
  "No numbering, no bullet characters, no preamble, no commentary.";

export async function summarizeTool(input: SummarizeToolInput): Promise<SummarizeToolResult> {
  if (input.slots.scope === "conversation") return summarizeConversation(input.userText);

  const cleaned = stripCommandPrefix(input.userText.trim());

  let points: string[] | null = null;
  if (!env.VOICE_MOCK) {
    points = await liveSummarize(cleaned);
  }
  const finalPoints = points ?? splitIntoPoints(cleaned);

  const card: SummaryCard = {
    type: "summary",
    points: finalPoints,
    source: cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned,
  };

  return {
    card,
    replyHint:
      finalPoints.length === 1
        ? `Summary: ${finalPoints[0]}`
        : `Here are ${finalPoints.length} key points.`,
  };
}

/** `transcript` is "User: …\nAgent: …" lines from the session. */
async function summarizeConversation(transcript: string): Promise<SummarizeToolResult> {
  let points: string[] | null = null;
  if (!env.VOICE_MOCK) {
    points = await liveSummarize(transcript, CONVERSATION_SYSTEM_PROMPT);
  }
  // Offline: list what the user asked, newest last.
  const finalPoints =
    points ??
    transcript
      .split("\n")
      .filter((l) => l.startsWith("User: "))
      .map((l) => `You asked: ${l.slice("User: ".length)}`)
      .slice(-5);

  return {
    card: { type: "summary", points: finalPoints, source: "this conversation" },
    replyHint:
      finalPoints.length === 1
        ? `So far: ${finalPoints[0]}`
        : `Here are ${finalPoints.length} key points from our conversation.`,
  };
}

async function liveSummarize(
  text: string,
  system: string = SUMMARIZE_SYSTEM_PROMPT,
): Promise<string[] | null> {
  if (!text) return null;
  try {
    const out = await generateToolText(system, text);
    const lines = out
      .split("\n")
      .map((line) => line.replace(/^\s*(?:[-*•–]|\d+[.)])\s*/, "").trim())
      .filter((line) => line.length > 0)
      .slice(0, 5);
    return lines.length > 0 ? lines : null;
  } catch {
    // Provider unavailable, over budget, or circuit open — fall back to
    // the deterministic sentence/clause splitter.
    return null;
  }
}

function splitIntoPoints(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length >= 2) {
    return sentences.slice(0, 5);
  }

  const clauses = text
    .split(/,|\band\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);

  if (clauses.length >= 2) {
    return clauses.slice(0, 5);
  }

  return [text || "No content to summarize."];
}

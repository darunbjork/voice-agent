import type { SummaryCard } from "@voice-agent/shared-types";

export type SummarizeToolInput = {
  userText: string;
  slots: Record<string, string>;
};

export type SummarizeToolResult = {
  card: SummaryCard;
  replyHint: string;
};

function stripCommandPrefix(text: string): string {
  return text
    .replace(/^\s*(?:please\s+)?(?:summarize|summarise|summary|recap|tldr|tl;dr)\s*[:-]?\s*/i, "")
    .trim();
}

export async function summarizeTool(input: SummarizeToolInput): Promise<SummarizeToolResult> {
  const cleaned = stripCommandPrefix(input.userText.trim());
  const points = splitIntoPoints(cleaned);

  const card: SummaryCard = {
    type: "summary",
    points,
    source: cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned,
  };

  return {
    card,
    replyHint:
      points.length === 1 ? `Summary: ${points[0]}` : `Here are ${points.length} key points.`,
  };
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

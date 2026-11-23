// Who built this app. Answered from code so the model can never invent it
// (or claim to be "made by Google").

export const APP_AUTHOR = "Darun Mustafa";
export const APP_REPO_URL = "https://github.com/darunbjork/voice-agent";

/** Spoken form: TTS reads "darunbjork slash voice-agent", not a raw URL. */
export const IDENTITY_REPLY = `I was built by ${APP_AUTHOR}. My source code is on GitHub at darunbjork slash voice-agent.`;

/** One line for the system prompt. */
export const IDENTITY_PROMPT_LINE =
  `About you: this voice agent was built by ${APP_AUTHOR}; the source code is at ` +
  `${APP_REPO_URL.replace("https://", "")}. If asked who made or built you or this app, say that. ` +
  "Never say you were made by Google, OpenAI or another model provider.";

const SELF = String.raw`(?:you|yourself|this\s+(?:app|application|assistant|agent|voice\s+agent|bot)|the\s+(?:app|assistant|agent))`;
const MADE = String.raw`(?:made|built|created|developed|wrote|programmed|designed|coded)`;

const IDENTITY_QUESTION = [
  new RegExp(String.raw`\bwho\s+(?:has\s+|have\s+)?${MADE}\s+${SELF}\b`, "i"),
  new RegExp(
    String.raw`\bwho\s+(?:is|are)\s+(?:your|the\s+app'?s)\s+(?:creator|developer|maker|author|builder)s?\b`,
    "i",
  ),
  new RegExp(
    String.raw`\bwhere\s+(?:is|can\s+i\s+(?:find|see))\s+(?:your|the\s+app'?s|this\s+app'?s)\s+(?:source\s+)?code\b`,
    "i",
  ),
];

/** The identity reply for "Who built you?" and similar, else null. */
export function identityAnswer(text: string): string | null {
  return IDENTITY_QUESTION.some((re) => re.test(text)) ? IDENTITY_REPLY : null;
}

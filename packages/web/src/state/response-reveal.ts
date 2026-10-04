export type RevealStatus = "idle" | "revealing" | "complete";

export interface RevealSnapshot {
  status: RevealStatus;
  totalWords: number;
  revealedWords: number;
}

export type RevealEvent =
  | { type: "START"; text: string; reduced: boolean }
  | { type: "PROGRESS"; progress: number }
  | { type: "COMPLETE" }
  | { type: "RESET" };

export const initialRevealState: RevealSnapshot = {
  status: "idle",
  totalWords: 0,
  revealedWords: 0,
};

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(1, Math.max(0, progress));
}

export function revealReducer(state: RevealSnapshot, event: RevealEvent): RevealSnapshot {
  switch (event.type) {
    case "START": {
      const totalWords = countWords(event.text);
      if (event.reduced || totalWords === 0) {
        return { status: "complete", totalWords, revealedWords: totalWords };
      }
      return { status: "revealing", totalWords, revealedWords: 0 };
    }
    case "PROGRESS": {
      if (state.status !== "revealing") return state;
      const target = Math.ceil(clampProgress(event.progress) * state.totalWords);
      const revealedWords = Math.max(state.revealedWords, Math.min(state.totalWords, target));
      if (revealedWords === state.revealedWords) return state;
      if (revealedWords >= state.totalWords) {
        return {
          status: "complete",
          totalWords: state.totalWords,
          revealedWords: state.totalWords,
        };
      }
      return { ...state, revealedWords };
    }
    case "COMPLETE": {
      if (state.status === "idle" || state.status === "complete") return state;
      return { status: "complete", totalWords: state.totalWords, revealedWords: state.totalWords };
    }
    case "RESET":
      return initialRevealState;
  }
}

export interface RevealToken {
  text: string;
  wordIndex: number | null;
}

export function revealTokens(text: string): RevealToken[] {
  const tokens: RevealToken[] = [];
  let wordIndex = 0;

  for (const part of text.split(/(\s+)/)) {
    if (part === "") continue;
    if (/^\s+$/.test(part)) {
      tokens.push({ text: part, wordIndex: null });
    } else {
      tokens.push({ text: part, wordIndex });
      wordIndex += 1;
    }
  }

  return tokens;
}

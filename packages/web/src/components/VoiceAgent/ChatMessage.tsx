import type { ChatMessageModel } from "../../types/chat.js";
import { ResponseCardView } from "../cards/ResponseCardView.js";
import { revealTokens } from "../../state/response-reveal.js";

export type ChatMessageProps = {
  message: ChatMessageModel;
  revealedWords?: number;
};

function RevealText({ text, revealedWords }: { text: string; revealedWords: number }) {
  return (
    <>
      {revealTokens(text).map((token, index) =>
        token.wordIndex !== null && token.wordIndex >= revealedWords ? (
          <span key={index} style={{ opacity: 0 }}>
            {token.text}
          </span>
        ) : (
          token.text
        ),
      )}
    </>
  );
}

export function ChatMessage({ message, revealedWords }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: 10,
      }}
    >
      <div
        style={{
          maxWidth: "92%",
          borderRadius: isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
          padding: isUser ? "0.65rem 0.9rem" : "0.7rem 0.9rem",
          background: isUser ? "var(--iris)" : "var(--surface-2)",
          border: isUser ? "none" : "1px solid var(--border)",
          color: isUser ? "#fff" : "var(--text)",
        }}
      >
        <div style={{ fontSize: 14, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
          {revealedWords === undefined ? (
            message.text
          ) : (
            <RevealText text={message.text} revealedWords={revealedWords} />
          )}
        </div>
        {!isUser && message.card && <ResponseCardView card={message.card} />}
        {!isUser && message.intent && (
          <div
            style={{
              marginTop: 6,
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--muted)",
              textTransform: "uppercase",
            }}
          >
            {message.intent}
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef } from "react";
import type { ChatMessageModel } from "../../types/chat.js";
import { ChatMessage } from "./ChatMessage.js";

export type ChatLogProps = {
  messages: ChatMessageModel[];
  interim?: string;
  emptyTitle?: string;
  emptyHint?: string;
};

const EMPTY_HEIGHT = 92;
const ACTIVE_HEIGHT = 120;
const MAX_HEIGHT = 280;

function MicGlyph() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ color: "var(--iris-soft)", opacity: 0.9 }}
    >
      <path
        d="M12 1.75a3.25 3.25 0 0 0-3.25 3.25v6a3.25 3.25 0 1 0 6.5 0v-6A3.25 3.25 0 0 0 12 1.75Z"
        fill="currentColor"
      />
      <path
        d="M7 11a5 5 0 0 0 10 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path d="M12 16v3.25" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M9 19.25h6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export function ChatLog({
  messages,
  interim,
  emptyTitle = "Tap the microphone to start a conversation",
  emptyHint = "Or pick a prompt below — try Weather, Reminder, or Help.",
}: ChatLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasContent = messages.length > 0 || Boolean(interim);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, interim]);

  return (
    <div
      className="chat-log"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="Conversation"
      style={{
        maxHeight: MAX_HEIGHT,
        minHeight: hasContent ? ACTIVE_HEIGHT : EMPTY_HEIGHT,
      }}
    >
      {!hasContent && (
        <div className="empty-state">
          <MicGlyph />
          <p className="empty-state__title">{emptyTitle}</p>
          <p className="empty-state__hint">{emptyHint}</p>
        </div>
      )}

      {messages.map((m) => (
        <ChatMessage key={m.id} message={m} />
      ))}

      {interim && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginBottom: 6,
          }}
        >
          <div
            style={{
              maxWidth: "92%",
              borderRadius: "14px 14px 4px 14px",
              padding: "0.55rem 0.85rem",
              background: "rgba(124, 58, 237, 0.35)",
              color: "var(--iris-soft)",
              fontSize: 14,
              fontStyle: "italic",
            }}
          >
            {interim}
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

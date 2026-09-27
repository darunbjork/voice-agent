import { useEffect, useRef } from "react";
import type { ChatMessageModel } from "../../types/chat.js";
import { ChatMessage } from "./ChatMessage.js";

export type ChatLogProps = {
  messages: ChatMessageModel[];
  interim?: string;
  emptyLabel?: string;
};

export function ChatLog({
  messages,
  interim,
  emptyLabel = "Conversation will appear here",
}: ChatLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, interim]);

  return (
    <div
      style={{
        background: "var(--surface-2)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border)",
        padding: "0.75rem",
        marginBottom: "1rem",
        maxHeight: 280,
        overflowY: "auto",
        minHeight: 120,
      }}
    >
      {messages.length === 0 && !interim && (
        <div
          style={{
            color: "var(--muted)",
            fontSize: 13,
            textAlign: "center",
            padding: "1.5rem 0.5rem",
          }}
        >
          {emptyLabel}
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

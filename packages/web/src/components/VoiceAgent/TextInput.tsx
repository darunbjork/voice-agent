import { useState } from "react";

export type TextInputProps = {
  onSubmitText: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
};

export function TextInput({
  onSubmitText,
  disabled = false,
  placeholder = "Type a message…",
}: TextInputProps) {
  const [value, setValue] = useState("");

  const submit = (): void => {
    const text = value.trim();
    if (!text || disabled) return;
    onSubmitText(text);
    setValue("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={{ display: "flex", gap: 8 }}
    >
      <label htmlFor="voice-agent-text-input" className="sr-only">
        Message
      </label>
      <input
        id="voice-agent-text-input"
        name="text"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
        style={{
          flex: 1,
          padding: "0.75rem 1rem",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border)",
          background: "var(--surface-2)",
          color: "var(--text)",
          fontSize: 14,
          opacity: disabled ? 0.6 : 1,
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "var(--iris)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "var(--border)";
        }}
      />
      <button
        type="submit"
        disabled={disabled || value.trim().length === 0}
        aria-label="Send message"
        style={{
          background: "var(--iris)",
          color: "#fff",
          border: "none",
          borderRadius: "var(--radius-md)",
          padding: "0 1rem",
          fontWeight: 600,
          fontSize: 13,
          cursor: disabled || value.trim().length === 0 ? "not-allowed" : "pointer",
          opacity: disabled || value.trim().length === 0 ? 0.5 : 1,
        }}
      >
        Send
      </button>
    </form>
  );
}

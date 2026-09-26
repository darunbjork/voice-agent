import { useCallback, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { useAudioCapture } from "./hooks/useAudioCapture.js";
import { useDeepgramProxy } from "./hooks/useDeepgramProxy.js";
import { useVAD } from "./hooks/useVAD.js";

export function App() {
  const [log, setLog] = useState<string[]>([]);
  const [interim, setInterim] = useState("");
  const [finalText, setFinalText] = useState("");
  const [utterances, setUtterances] = useState<string[]>([]);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 40));
  }, []);

  const proxy = useDeepgramProxy({
    handlers: {
      onSessionId: (id) => appendLog(`session_id → ${id}`),
      onInterim: (text) => {
        setInterim(text);
      },
      onFinal: (text, latencyMs) => {
        setFinalText(text);
        setInterim("");
        setUtterances((prev) => [text, ...prev].slice(0, 10));
        appendLog(`FINAL utterance → "${text}" (${latencyMs} ms)`);
      },
      onError: (code, message) => {
        appendLog(`error → ${code}: ${message}`);
      },
      onMessage: (msg) => {
        if (
          msg.type !== "transcript_interim" &&
          msg.type !== "transcript_final" &&
          msg.type !== "session_id" &&
          msg.type !== "error"
        ) {
          appendLog(`msg → ${msg.type}`);
        }
      },
    },
  });

  const vad = useVAD({
    threshold: 0.02,
    minSpeechMs: 150,
    silenceDurationMs: 500,
    onSpeechStart: () => appendLog("VAD → speech_start"),
    onSpeechEnd: () => appendLog("VAD → speech_end (500 ms silence)"),
  });

  const capture = useAudioCapture({
    onChunk: (chunk) => proxy.sendAudio(chunk),
    onRms: (rms) => vad.feed(rms),
  });

  const handleStart = async () => {
    proxy.connect();
    await capture.start();
    appendLog("capture + proxy started");
  };

  const handleStop = () => {
    capture.stop();
    proxy.disconnect();
    vad.reset();
    setInterim("");
    appendLog("stopped");
  };

  const handleTextSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem("text") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    proxy.sendMessage({ type: "text_input", text });
    input.value = "";
    appendLog(`text_input → ${text}`);
  };

  const vadColor = vad.state === "speech" ? "#22c55e" : capture.isCapturing ? "#a78bfa" : "#64748b";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0f",
        color: "#e2e8f0",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        maxWidth: 720,
      }}
    >
      <h1 style={{ marginTop: 0 }}>Voice Agent</h1>
      <p>Client-side VAD: 500 ms endpointing, finals-only utterances</p>

      <div style={{ display: "flex", gap: "1rem", margin: "1.5rem 0" }}>
        <button onClick={handleStart} disabled={capture.isCapturing} style={btnStyle}>
          Start Mic
        </button>
        <button
          onClick={handleStop}
          disabled={!capture.isCapturing && proxy.status === "disconnected"}
          style={btnStyle}
        >
          Stop
        </button>
      </div>

      <div style={{ marginBottom: "0.75rem", fontSize: 14 }}>
        <strong>Capture:</strong> {capture.status}
        {"  |  "}
        <strong>Proxy:</strong> {proxy.status}
        {"  |  "}
        <strong style={{ color: vadColor }}>VAD: {vad.state}</strong>
        {proxy.sessionId && (
          <>
            {"  |  "}
            <strong>Session:</strong> {proxy.sessionId.slice(0, 8)}…
          </>
        )}
        {capture.error && <span style={{ color: "#ef4444" }}> — {capture.error}</span>}
        {proxy.lastError && <span style={{ color: "#ef4444" }}> — {proxy.lastError}</span>}
      </div>

      <div
        style={{
          height: 12,
          background: "#16161f",
          borderRadius: 6,
          overflow: "hidden",
          maxWidth: 320,
          marginBottom: "1rem",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.min(100, capture.level * 400)}%`,
            background: vad.state === "speech" ? "#22c55e" : "#7c3aed",
            transition: "width 50ms linear, background 150ms",
          }}
        />
      </div>

      <div
        style={{
          background: "#111118",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 12,
          padding: "1rem",
          marginBottom: "1rem",
          minHeight: 72,
        }}
      >
        <div style={{ color: "#64748b", fontSize: 12, marginBottom: 4 }}>
          Live transcript {vad.state === "speech" ? "(speaking…)" : ""}
        </div>
        <div style={{ fontSize: 18 }}>
          {finalText && <span style={{ color: "#e2e8f0" }}>{finalText}</span>}
          {interim && (
            <span style={{ color: "#a78bfa", marginLeft: finalText ? 8 : 0 }}>{interim}</span>
          )}
          {!finalText && !interim && <span style={{ color: "#64748b" }}>…</span>}
        </div>
      </div>

      {utterances.length > 0 && (
        <div style={{ marginBottom: "1.5rem" }}>
          <div style={{ color: "#64748b", fontSize: 12, marginBottom: 6 }}>
            Completed utterances (finals only)
          </div>
          <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
            {utterances.map((u, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {u}
              </li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={handleTextSubmit} style={{ marginBottom: "1.5rem" }}>
        <input
          name="text"
          placeholder="Or type a message…"
          style={{
            width: "100%",
            padding: "0.75rem 1rem",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "#16161f",
            color: "#e2e8f0",
            fontSize: 15,
            boxSizing: "border-box",
          }}
        />
      </form>

      <h3 style={{ marginBottom: "0.5rem" }}>Event log</h3>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          opacity: 0.85,
          maxHeight: 240,
          overflow: "auto",
        }}
      >
        {log.map((line, i) => (
          <li key={i} style={{ padding: "2px 0" }}>
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

const btnStyle: CSSProperties = {
  background: "#7c3aed",
  color: "white",
  border: "none",
  borderRadius: 8,
  padding: "0.6rem 1.2rem",
  cursor: "pointer",
  fontWeight: 600,
};

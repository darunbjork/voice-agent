import { useCallback, useState } from "react";
import type { CSSProperties } from "react";
import { useAudioCapture } from "./hooks/useAudioCapture.js";
import { useDeepgramProxy } from "./hooks/useDeepgramProxy.js";
import type { ServerAudioMessage } from "@voice-agent/shared-types";

export function App() {
  const [log, setLog] = useState<string[]>([]);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 30));
  }, []);

  const proxy = useDeepgramProxy({
    onMessage: (msg: ServerAudioMessage) => {
      if (msg.type === "session_id") {
        appendLog(`session_id → ${msg.sessionId}`);
      } else if (msg.type === "transcript_interim") {
        appendLog(`interim → ${msg.text}`);
      } else if (msg.type === "transcript_final") {
        appendLog(`FINAL → ${msg.text} (${msg.latencyMs} ms)`);
      } else if (msg.type === "error") {
        appendLog(`error → ${msg.code}: ${msg.message}`);
      }
    },
  });

  const capture = useAudioCapture({
    onChunk: (chunk) => proxy.sendAudio(chunk),
  });

  const handleStart = async () => {
    proxy.connect();
    await capture.start();
    appendLog("capture started");
  };

  const handleStop = () => {
    capture.stop();
    proxy.sendMessage({ type: "session_end" });
    proxy.disconnect();
    appendLog("capture stopped");
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0f",
        color: "#e2e8f0",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
      }}
    >
      <h1 style={{ marginTop: 0 }}>Voice Agent</h1>
      <p>Mic → 16 kHz PCM → WebSocket proxy (mock transcripts)</p>

      <div style={{ display: "flex", gap: "1rem", margin: "1.5rem 0" }}>
        <button onClick={handleStart} disabled={capture.isCapturing} style={btnStyle}>
          Start Mic
        </button>
        <button onClick={handleStop} disabled={!capture.isCapturing} style={btnStyle}>
          Stop
        </button>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <strong>Status:</strong> capture={capture.status} | proxy={proxy.status}
        {capture.error && <span style={{ color: "#ef4444" }}> — {capture.error}</span>}
      </div>

      <div
        style={{
          height: 12,
          background: "#16161f",
          borderRadius: 6,
          overflow: "hidden",
          maxWidth: 320,
          marginBottom: "1.5rem",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.min(100, capture.level * 400)}%`,
            background: "#7c3aed",
            transition: "width 50ms linear",
          }}
        />
      </div>

      <h3>Event log</h3>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          fontFamily: "monospace",
          fontSize: 13,
          opacity: 0.9,
        }}
      >
        {log.map((line, i) => (
          <li key={i}>{line}</li>
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

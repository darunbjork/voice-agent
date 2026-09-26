import { useCallback, useMemo, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { useAudioCapture } from "./hooks/useAudioCapture.js";
import { useDeepgramProxy } from "./hooks/useDeepgramProxy.js";
import { useVAD } from "./hooks/useVAD.js";
import { useTTSPlayer } from "./hooks/useTTSPlayer.js";
import { useBargeIn } from "./hooks/useBargeIn.js";
import { useWaveform } from "./hooks/useWaveform.js";
import { VoiceAgentLayout } from "./components/VoiceAgent/VoiceAgent.js";
import type { AgentVisualState } from "./components/VoiceAgent/StatusRing.js";

const VAD_MIN_SPEECH_MS = 100;

const STATE_COLORS: Record<AgentVisualState, string> = {
  idle: "#64748b",
  listening: "#22c55e",
  processing: "#f59e0b",
  speaking: "#a78bfa",
  interrupted: "#ef4444",
};

const STATE_LABELS: Record<AgentVisualState, string> = {
  idle: "Idle",
  listening: "Listening",
  processing: "Processing",
  speaking: "Speaking",
  interrupted: "Interrupted",
};

export function App() {
  const [log, setLog] = useState<string[]>([]);
  const [interim, setInterim] = useState("");
  const [finalText, setFinalText] = useState("");
  const [utterances, setUtterances] = useState<string[]>([]);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 40));
  }, []);

  const tts = useTTSPlayer({
    onDone: () => appendLog("TTS playback finished"),
    onCancel: () => appendLog("TTS playback cancelled"),
  });

  const proxy = useDeepgramProxy({
    handlers: {
      onSessionId: (id) => appendLog(`session_id → ${id}`),
      onInterim: (text) => setInterim(text),
      onFinal: (text, latencyMs) => {
        setFinalText(text);
        setInterim("");
        setUtterances((prev) => [text, ...prev].slice(0, 8));
        appendLog(`FINAL → "${text}" (${latencyMs} ms)`);
        tts.prepare();
      },
      onTtsChunk: (audio, sequenceNum) => {
        void tts.enqueue(audio, sequenceNum);
      },
      onTtsDone: () => tts.markDone(),
      onError: (code, message) => appendLog(`error → ${code}: ${message}`),
      onMessage: (msg) => {
        if (
          msg.type !== "transcript_interim" &&
          msg.type !== "transcript_final" &&
          msg.type !== "session_id" &&
          msg.type !== "error" &&
          msg.type !== "tts_chunk" &&
          msg.type !== "tts_done"
        ) {
          appendLog(`msg → ${msg.type}`);
        }
      },
    },
  });

  const waveform = useWaveform(64);

  const vad = useVAD({
    threshold: 0.02,
    minSpeechMs: VAD_MIN_SPEECH_MS,
    silenceDurationMs: 500,
    onSpeechStart: () => appendLog("VAD → speech_start"),
    onSpeechEnd: () => appendLog("VAD → speech_end (500 ms silence)"),
  });

  const bargeIn = useBargeIn({
    isTtsPlaying: tts.isPlaying,
    isUserSpeaking: vad.state === "speech",
    cancelTts: tts.cancel,
    sendBargeIn: () => proxy.sendMessage({ type: "barge_in" }),
    minSpeechMs: 0,
    cooldownMs: 400,
    onBargeIn: (localWorkMs) => {
      const totalMs = VAD_MIN_SPEECH_MS + localWorkMs;
      appendLog(
        `BARGE-IN fired — VAD ${VAD_MIN_SPEECH_MS} ms + local ${localWorkMs.toFixed(1)} ms ≈ ${totalMs.toFixed(1)} ms`,
      );
    },
  });

  const capture = useAudioCapture({
    onChunk: (chunk) => proxy.sendAudio(chunk),
    onRms: (rms) => {
      vad.feed(rms);
      waveform.feed(rms);
    },
  });

  const visualState: AgentVisualState = useMemo(() => {
    if (bargeIn.isTriggered || bargeIn.status === "cooldown") {
      return "interrupted";
    }
    if (tts.isPlaying) return "speaking";
    if (vad.state === "speech" || capture.isCapturing) return "listening";
    return "idle";
  }, [bargeIn.isTriggered, bargeIn.status, tts.isPlaying, vad.state, capture.isCapturing]);

  const statusLabel = STATE_LABELS[visualState];
  const waveformColor = STATE_COLORS[visualState];

  const handleStart = async () => {
    proxy.connect();
    await capture.start();
    appendLog("capture + proxy started");
  };

  const handleStop = () => {
    tts.cancel();
    capture.stop();
    proxy.disconnect();
    vad.reset();
    waveform.reset();
    setInterim("");
    appendLog("stopped");
  };

  const handleManualBarge = () => {
    tts.cancel();
    proxy.sendMessage({ type: "barge_in" });
    appendLog("manual barge_in");
  };

  const handleTextSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem("text") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    tts.prepare();
    proxy.sendMessage({ type: "text_input", text });
    input.value = "";
    appendLog(`text_input → ${text}`);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--void)",
        color: "var(--text)",
        padding: "2rem",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "1.5rem",
      }}
    >
      <header style={{ textAlign: "center" }}>
        <h1 style={{ margin: "0 0 0.35rem", fontSize: 28, fontWeight: 700 }}>Voice Agent</h1>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 14 }}>Waveform + Status Ring</p>
      </header>

      <VoiceAgentLayout
        visualState={visualState}
        waveformBufferRef={waveform.bufferRef}
        waveformColor={waveformColor}
        statusLabel={statusLabel}
      >
        <div
          style={{
            background: "var(--surface-2)",
            borderRadius: 12,
            padding: "0.85rem 1rem",
            marginBottom: "1rem",
            minHeight: 56,
          }}
        >
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>Transcript</div>
          <div style={{ fontSize: 16 }}>
            {finalText && <span>{finalText}</span>}
            {interim && (
              <span
                style={{
                  color: "var(--iris-soft)",
                  marginLeft: finalText ? 6 : 0,
                }}
              >
                {interim}
              </span>
            )}
            {!finalText && !interim && <span style={{ color: "var(--muted)" }}>…</span>}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            flexWrap: "wrap",
            marginBottom: "1rem",
          }}
        >
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
          <button
            onClick={handleManualBarge}
            disabled={!tts.isPlaying}
            style={{ ...btnStyle, background: "var(--error)" }}
          >
            Interrupt
          </button>
        </div>
        <form onSubmit={handleTextSubmit}>
          <input
            name="text"
            placeholder="Type instead of speaking…"
            style={{
              width: "100%",
              padding: "0.7rem 1rem",
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--surface-2)",
              color: "var(--text)",
              fontSize: 14,
              boxSizing: "border-box",
            }}
          />
        </form>
        <div
          style={{
            marginTop: "0.85rem",
            fontSize: 12,
            color: "var(--muted)",
            display: "flex",
            gap: "0.75rem",
            flexWrap: "wrap",
          }}
        >
          <span>capture: {capture.status}</span>
          <span>proxy: {proxy.status}</span>
          <span>vad: {vad.state}</span>
          <span>tts: {tts.status}</span>
          <span>barge: {bargeIn.status}</span>
          {bargeIn.lastLocalWorkMs !== null && (
            <span>local: {bargeIn.lastLocalWorkMs.toFixed(1)} ms</span>
          )}
        </div>
      </VoiceAgentLayout>
      {log.length > 0 && (
        <div
          style={{
            width: "100%",
            maxWidth: 440,
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            color: "var(--muted)",
            maxHeight: 140,
            overflow: "auto",
          }}
        >
          {log.slice(0, 12).map((line, i) => (
            <div key={i} style={{ padding: "1px 0" }}>
              {line}
            </div>
          ))}
        </div>
      )}

      {utterances.length > 0 && (
        <div
          style={{
            width: "100%",
            maxWidth: 440,
            fontSize: 13,
            color: "var(--text)",
          }}
        >
          <div
            style={{
              color: "var(--muted)",
              marginBottom: 6,
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Recent
          </div>
          {utterances.map((u, i) => (
            <div key={i} style={{ marginBottom: 3, opacity: 1 - i * 0.08 }}>
              “{u}”
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const btnStyle: CSSProperties = {
  background: "var(--iris)",
  color: "white",
  border: "none",
  borderRadius: 10,
  padding: "0.55rem 1.1rem",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 14,
};

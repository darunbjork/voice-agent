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
import type { ResponseCard } from "@voice-agent/shared-types";

const VAD_MIN_SPEECH_MS = 100;

export function App() {
  const [log, setLog] = useState<string[]>([]);
  const [interim, setInterim] = useState("");
  const [finalText, setFinalText] = useState("");
  const [agentText, setAgentText] = useState("");
  const [lastCard, setLastCard] = useState<ResponseCard | null>(null);
  const [agentThinking, setAgentThinking] = useState(false);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 24));
  }, []);

  const tts = useTTSPlayer({
    onDone: () => appendLog("TTS done"),
    onCancel: () => appendLog("TTS cancelled"),
  });

  const proxy = useDeepgramProxy({
    handlers: {
      onSessionId: (id) => appendLog(`session ${id.slice(0, 8)}`),
      onInterim: (text) => setInterim(text),
      onFinal: (text, latencyMs) => {
        setFinalText(text);
        setInterim("");
        appendLog(`final (${latencyMs}ms)`);
        tts.prepare();
      },
      onAgentThinking: () => {
        setAgentThinking(true);
        appendLog("thinking…");
      },
      onAgentResponse: (msg) => {
        setAgentThinking(false);
        setAgentText(msg.reply.text);
        setLastCard(msg.reply.card);
        appendLog(`intent=${msg.reply.intent}`);
      },
      onTtsChunk: (audio, sequenceNum) => {
        void tts.enqueue(audio, sequenceNum);
      },
      onTtsDone: () => tts.markDone(),
      onError: (code, message) => {
        setAgentThinking(false);
        appendLog(`err ${code}: ${message}`);
      },
      onMessage: (msg) => {
        const type = msg.type;
        if (
          type !== "transcript_interim" &&
          type !== "transcript_final" &&
          type !== "session_id" &&
          type !== "error" &&
          type !== "tts_chunk" &&
          type !== "tts_done" &&
          type !== "agent_thinking" &&
          type !== "agent_response"
        ) {
          appendLog(`msg ${type}`);
        }
      },
    },
  });

  const waveform = useWaveform(64);

  const vad = useVAD({
    threshold: 0.02,
    minSpeechMs: VAD_MIN_SPEECH_MS,
    silenceDurationMs: 500,
    onSpeechStart: () => appendLog("speech_start"),
    onSpeechEnd: () => appendLog("speech_end"),
  });

  const bargeIn = useBargeIn({
    isTtsPlaying: tts.isPlaying,
    isUserSpeaking: vad.state === "speech",
    cancelTts: tts.cancel,
    sendBargeIn: () => proxy.sendMessage({ type: "barge_in" }),
    minSpeechMs: 0,
    cooldownMs: 400,
    onBargeIn: (localWorkMs) => {
      const total = VAD_MIN_SPEECH_MS + localWorkMs;
      appendLog(`barge-in ${total.toFixed(0)}ms`);
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
    if (agentThinking) return "processing";
    if (vad.state === "speech" || capture.isCapturing) return "listening";
    return "idle";
  }, [
    bargeIn.isTriggered,
    bargeIn.status,
    tts.isPlaying,
    agentThinking,
    vad.state,
    capture.isCapturing,
  ]);

  const statusLabel: Record<AgentVisualState, string> = {
    idle: "Idle",
    listening: "Listening",
    processing: "Processing",
    speaking: "Speaking",
    interrupted: "Interrupted",
  };

  const waveformColor: Record<AgentVisualState, string> = {
    idle: "var(--muted)",
    listening: "var(--success)",
    processing: "var(--ember)",
    speaking: "var(--iris-soft)",
    interrupted: "var(--error)",
  };

  const handleStart = async () => {
    proxy.connect();
    await capture.start();
    appendLog("started");
  };

  const handleStop = () => {
    tts.cancel();
    capture.stop();
    proxy.disconnect();
    vad.reset();
    waveform.reset();
    setInterim("");
    setAgentThinking(false);
    appendLog("stopped");
  };

  const handleTextSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem("text") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    if (!proxy.isConnected) proxy.connect();
    tts.prepare();
    proxy.sendMessage({ type: "text_input", text });
    input.value = "";
    appendLog(`text → ${text.slice(0, 40)}`);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--void)",
        backgroundImage:
          "radial-gradient(ellipse 80% 50% at 50% -20%, var(--iris-glow), transparent)",
        color: "var(--text)",
        padding: "2rem 1.25rem 3rem",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "1.75rem",
      }}
    >
      <header style={{ textAlign: "center", maxWidth: 480 }}>
        <h1
          style={{
            margin: "0 0 0.4rem",
            fontFamily: "var(--font-display)",
            fontSize: "clamp(1.75rem, 4vw, 2.15rem)",
            fontWeight: 700,
            letterSpacing: "-0.03em",
          }}
        >
          Voice Agent
        </h1>
        <p
          style={{
            margin: 0,
            color: "var(--muted)",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          Production voice pipeline · Deepgram · Gemini · ElevenLabs
        </p>
      </header>

      <VoiceAgentLayout
        visualState={visualState}
        waveformBufferRef={waveform.bufferRef}
        waveformColor={waveformColor[visualState]}
        statusLabel={statusLabel[visualState]}
        sessionId={proxy.sessionId}
        footer="Darun Mustafa · darun.dev"
      >
        <div
          style={{
            background: "var(--surface-2)",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border)",
            padding: "0.9rem 1rem",
            marginBottom: "1rem",
            minHeight: 72,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: "var(--muted)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 6,
            }}
          >
            Transcript
          </div>
          <div style={{ fontSize: 15, lineHeight: 1.45 }}>
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
            {!finalText && !interim && (
              <span style={{ color: "var(--muted)" }}>Speak or type to begin…</span>
            )}
          </div>
          {agentText && (
            <div
              style={{
                marginTop: 10,
                paddingTop: 10,
                borderTop: "1px solid var(--border)",
                fontSize: 14,
                color: "var(--iris-soft)",
              }}
            >
              {agentText}
            </div>
          )}
        </div>

        {lastCard && (
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border-hover)",
              borderRadius: "var(--radius-md)",
              padding: "0.75rem 1rem",
              marginBottom: "1rem",
              fontSize: 13,
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--iris-soft)",
                textTransform: "uppercase",
              }}
            >
              {lastCard.type}
            </span>
            <pre
              style={{
                margin: "0.4rem 0 0",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--muted)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {JSON.stringify(lastCard, null, 2)}
            </pre>
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: "0.6rem",
            flexWrap: "wrap",
            marginBottom: "0.85rem",
          }}
        >
          <button
            type="button"
            onClick={handleStart}
            disabled={capture.isCapturing}
            style={primaryBtn}
          >
            {capture.isCapturing ? "Listening…" : "Start Mic"}
          </button>
          <button
            type="button"
            onClick={handleStop}
            disabled={!capture.isCapturing && !proxy.isConnected}
            style={ghostBtn}
          >
            Stop
          </button>
          <button
            type="button"
            onClick={() => {
              tts.cancel();
              proxy.sendMessage({ type: "barge_in" });
              appendLog("manual barge-in");
            }}
            disabled={!tts.isPlaying}
            style={{
              ...ghostBtn,
              color: "var(--error)",
              borderColor: "var(--error)",
            }}
          >
            Interrupt
          </button>
        </div>

        <form onSubmit={handleTextSubmit}>
          <input
            name="text"
            placeholder="Type a message…"
            autoComplete="off"
            style={{
              width: "100%",
              padding: "0.75rem 1rem",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border)",
              background: "var(--surface-2)",
              color: "var(--text)",
              fontSize: 14,
              outline: "none",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--iris)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--border)";
            }}
          />
        </form>
      </VoiceAgentLayout>

      <div
        style={{
          width: "100%",
          maxWidth: 480,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--muted)",
          maxHeight: 120,
          overflow: "auto",
          opacity: 0.85,
        }}
      >
        {log.map((line, i) => (
          <div key={i} style={{ padding: "1px 0" }}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

const primaryBtn: CSSProperties = {
  background: "var(--iris)",
  color: "#fff",
  border: "none",
  borderRadius: "var(--radius-sm)",
  padding: "0.55rem 1.15rem",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
};

const ghostBtn: CSSProperties = {
  background: "transparent",
  color: "var(--text)",
  border: "1px solid var(--border-hover)",
  borderRadius: "var(--radius-sm)",
  padding: "0.55rem 1.15rem",
  fontWeight: 500,
  fontSize: 13,
  cursor: "pointer",
};

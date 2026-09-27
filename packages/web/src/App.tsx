import { useCallback, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useAudioCapture } from "./hooks/useAudioCapture.js";
import { useDeepgramProxy } from "./hooks/useDeepgramProxy.js";
import { useVAD } from "./hooks/useVAD.js";
import { useTTSPlayer } from "./hooks/useTTSPlayer.js";
import { useBargeIn } from "./hooks/useBargeIn.js";
import { useWaveform } from "./hooks/useWaveform.js";
import { VoiceAgentLayout } from "./components/VoiceAgent/VoiceAgent.js";
import { ChatLog } from "./components/VoiceAgent/ChatLog.js";
import { QuickActions } from "./components/VoiceAgent/QuickActions.js";
import { TextInput } from "./components/VoiceAgent/TextInput.js";
import type { AgentVisualState } from "./components/VoiceAgent/StatusRing.js";
import type { ChatMessageModel } from "./types/chat.js";
import "./styles/globals.css";

const VAD_MIN_SPEECH_MS = 100;

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function App() {
  const [log, setLog] = useState<string[]>([]);
  const [interim, setInterim] = useState("");
  const [messages, setMessages] = useState<ChatMessageModel[]>([]);
  const [agentThinking, setAgentThinking] = useState(false);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 20));
  }, []);

  const pushMessage = useCallback((msg: Omit<ChatMessageModel, "id" | "createdAt">) => {
    setMessages((prev) => [...prev, { ...msg, id: newId(), createdAt: new Date().toISOString() }]);
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
        setInterim("");
        pushMessage({ role: "user", text });
        appendLog(`final (${latencyMs}ms)`);
        tts.prepare();
      },
      onAgentThinking: () => {
        setAgentThinking(true);
        appendLog("thinking…");
      },
      onAgentResponse: (msg) => {
        setAgentThinking(false);
        pushMessage({
          role: "agent",
          text: msg.reply.text,
          card: msg.reply.card,
          intent: msg.reply.intent,
        });
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

  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (tts.isPlaying) {
        tts.cancel();
        proxy.sendMessage({ type: "barge_in" });
      }

      if (!proxy.isConnected) {
        proxy.connect();
      }

      tts.prepare();
      proxy.sendMessage({ type: "text_input", text: trimmed });
      appendLog(`text_input → ${trimmed.slice(0, 48)}`);
    },
    [proxy, tts, appendLog],
  );

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
    idle: "#64748b",
    listening: "#22c55e",
    processing: "#f59e0b",
    speaking: "#a78bfa",
    interrupted: "#ef4444",
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

  const handleManualBarge = () => {
    tts.cancel();
    proxy.sendMessage({ type: "barge_in" });
    appendLog("manual barge-in");
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
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 14 }}>
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
        <ChatLog messages={messages} interim={interim} />

        <QuickActions onAction={sendText} />

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
            onClick={handleManualBarge}
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

        <TextInput onSubmitText={sendText} />
      </VoiceAgentLayout>

      <div
        style={{
          width: "100%",
          maxWidth: 480,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--muted)",
          maxHeight: 100,
          overflow: "auto",
        }}
      >
        {log.map((line, i) => (
          <div key={i}>{line}</div>
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

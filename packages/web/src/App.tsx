import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { LatencyBreakdown } from "@voice-agent/shared-types";
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
import { MicButton } from "./components/VoiceAgent/MicButton.js";
import { SkipLink } from "./components/a11y/SkipLink.js";
import { LiveRegion } from "./components/VoiceAgent/LiveRegion.js";
import { AdminPage } from "./pages/AdminPage.js";
import { LatencyHUD, type LatencyStage } from "./components/VoiceAgent/LatencyHUD.js";
import type { AgentVisualState } from "./components/VoiceAgent/StatusRing.js";
import type { ChatMessageModel } from "./types/chat.js";
import { playFeedbackTone } from "./lib/feedback-tone.js";
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
  const [latency, setLatency] = useState<LatencyBreakdown | null>(null);
  const [stage, setStage] = useState<LatencyStage | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [view, setView] = useState<"agent" | "admin">("agent");
  const ttsWaitStartedRef = useRef<number | null>(null);
  const ttsFirstByteRef = useRef<boolean>(false);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 20));
  }, []);

  const flashFeedback = useCallback((text: string) => {
    setFeedback(text);
    if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), 2800);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current);
    };
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
        setStage("llm");
        setLatency({ stt: latencyMs, llm: 0, tts: 0, total: latencyMs });
        tts.prepare();
      },
      onAgentThinking: () => {
        setAgentThinking(true);
        setStage("llm");
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
        setStage("tts");
        setLatency({
          stt: msg.reply.latencyMs.stt,
          llm: msg.reply.latencyMs.llm,
          tts: 0,
          total: msg.reply.latencyMs.stt + msg.reply.latencyMs.llm,
        });
        ttsWaitStartedRef.current = performance.now();
        ttsFirstByteRef.current = false;
        appendLog(`intent=${msg.reply.intent}`);
      },
      onTtsChunk: (audio, sequenceNum) => {
        if (!ttsFirstByteRef.current && ttsWaitStartedRef.current !== null) {
          const firstByteMs = Math.round(performance.now() - ttsWaitStartedRef.current);
          ttsFirstByteRef.current = true;
          setStage(null);
          setLatency((prev) => {
            if (!prev) return prev;
            return {
              stt: prev.stt,
              llm: prev.llm,
              tts: firstByteMs,
              total: prev.stt + prev.llm + firstByteMs,
            };
          });
        }
        void tts.enqueue(audio, sequenceNum);
      },
      onTtsDone: () => {
        setStage(null);
        tts.markDone();
      },
      onError: (code, message) => {
        setAgentThinking(false);
        setStage(null);
        appendLog(`err ${code}: ${message}`);
        flashFeedback(`Error: ${message}`);
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

  const captureFailed = capture.status === "error";

  useEffect(() => {
    if (capture.status !== "error") return;
    setStage(null);
    setAgentThinking(false);
    playFeedbackTone("error");
    appendLog("mic permission error");
  }, [capture.status, appendLog]);

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
    idle: "#94a3b8",
    listening: "#22c55e",
    processing: "#f59e0b",
    speaking: "#a78bfa",
    interrupted: "#ef4444",
  };

  const handleStop = () => {
    tts.cancel();
    capture.stop();
    proxy.disconnect();
    vad.reset();
    waveform.reset();
    setInterim("");
    setAgentThinking(false);
    setStage(null);
    appendLog("stopped");
    flashFeedback("Disconnected — microphone off and session closed");
  };

  const handleManualBarge = () => {
    tts.cancel();
    proxy.sendMessage({ type: "barge_in" });
    appendLog("manual barge-in");
    flashFeedback("Interrupted — agent stopped speaking");
  };

  const retryMicrophone = () => {
    appendLog("mic retry");
    void capture.start();
  };

  const micVariant: "idle" | "listening" | "speaking" | "interrupted" =
    visualState === "interrupted"
      ? "interrupted"
      : visualState === "speaking"
        ? "speaking"
        : visualState === "listening"
          ? "listening"
          : "idle";

  const liveMessage = {
    idle: "Agent idle",
    listening: "Listening",
    processing: "Processing",
    speaking: "Agent speaking",
    interrupted: "Interrupted",
  }[visualState];

  if (view === "admin") {
    return (
      <>
        <SkipLink />
        <main id="main-content">
          <AdminPage onBack={() => setView("agent")} />
        </main>
      </>
    );
  }

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
      <SkipLink />
      <LiveRegion message={liveMessage} />

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
        <p style={{ margin: "0 0 0.6rem", color: "var(--muted)", fontSize: 14 }}>
          Production voice pipeline · Deepgram · Gemini · ElevenLabs
        </p>
        <button
          type="button"
          onClick={() => setView("admin")}
          style={{
            ...ghostBtn,
            fontSize: 12,
            padding: "0.35rem 0.75rem",
          }}
        >
          Admin
        </button>
      </header>

      <main id="main-content">
        <VoiceAgentLayout
          visualState={visualState}
          waveformBufferRef={waveform.bufferRef}
          waveformColor={waveformColor[visualState]}
          statusLabel={statusLabel[visualState]}
          statusActive={visualState === "processing"}
          sessionId={proxy.sessionId}
          footer="Darun Mustafa · darun.dev"
        >
          {capture.status === "requesting_permission" && (
            <div className="banner banner--info" role="status">
              Requesting microphone access — allow the prompt to start talking.
            </div>
          )}

          {captureFailed && capture.error && (
            <div className="banner banner--error" role="alert">
              <span>{capture.error}</span>
              <button type="button" className="banner__action" onClick={retryMicrophone}>
                Try again
              </button>
            </div>
          )}

          <LatencyHUD latency={latency} stage={stage} />
          <ChatLog messages={messages} interim={interim} />

          <QuickActions onAction={sendText} />

          <MicButton
            isCapturing={capture.isCapturing}
            disabled={capture.status === "requesting_permission"}
            onStart={async () => {
              if (!proxy.isConnected) proxy.connect();
              setStage("stt");
              await capture.start();
              appendLog("mic on");
            }}
            onStop={() => {
              capture.stop();
              setStage(null);
              appendLog("mic off");
            }}
            variant={micVariant}
          />

          {feedback && (
            <div
              className="banner banner--info"
              role="status"
              style={{ justifyContent: "center", textAlign: "center", marginBottom: "0.6rem" }}
            >
              {feedback}
            </div>
          )}

          <div
            style={{
              display: "flex",
              gap: "0.6rem",
              flexWrap: "wrap",
              justifyContent: "center",
              marginBottom: "0.85rem",
            }}
          >
            <button
              type="button"
              onClick={handleManualBarge}
              disabled={!tts.isPlaying}
              title="Stop the agent mid-sentence"
              aria-label="Interrupt agent speech"
              style={{
                ...ghostBtn,
                color: "var(--ember)",
                borderColor: "rgba(245, 158, 11, 0.55)",
              }}
            >
              Interrupt
            </button>
            <button
              type="button"
              onClick={handleStop}
              disabled={!capture.isCapturing && !proxy.isConnected}
              title="Turn off the microphone and close the session"
              style={ghostBtn}
            >
              Disconnect
            </button>
          </div>

          <TextInput onSubmitText={sendText} />
        </VoiceAgentLayout>
      </main>

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

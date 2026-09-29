export type FeedbackTone = "listen-start" | "listen-stop" | "error";

type NoteSpec = {
  frequency: number;
  durationMs: number;
  delayMs?: number;
  gain?: number;
  type?: OscillatorType;
};

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  if (!audioContext || audioContext.state === "closed") {
    try {
      audioContext = new Ctor();
    } catch {
      return null;
    }
  }
  if (audioContext.state === "suspended") {
    void audioContext.resume().catch(() => undefined);
  }
  return audioContext;
}

function playNote(ac: AudioContext, spec: NoteSpec): void {
  const { frequency, durationMs, delayMs = 0, gain = 0.05, type = "sine" } = spec;

  const start = ac.currentTime + delayMs / 1000;
  const end = start + durationMs / 1000;

  const osc = ac.createOscillator();
  const amp = ac.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);

  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.015);
  amp.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(amp);
  amp.connect(ac.destination);
  osc.start(start);
  osc.stop(end + 0.02);
  osc.onended = () => {
    osc.disconnect();
    amp.disconnect();
  };
}

const TONES: Record<FeedbackTone, NoteSpec[]> = {
  "listen-start": [
    { frequency: 659.25, durationMs: 90, gain: 0.045 },
    { frequency: 880, durationMs: 140, delayMs: 90, gain: 0.05 },
  ],
  "listen-stop": [
    { frequency: 587.33, durationMs: 80, gain: 0.035 },
    { frequency: 440, durationMs: 140, delayMs: 80, gain: 0.04 },
  ],
  error: [
    { frequency: 220, durationMs: 130, gain: 0.05, type: "triangle" },
    { frequency: 185, durationMs: 200, delayMs: 150, gain: 0.05, type: "triangle" },
  ],
};

export function playFeedbackTone(kind: FeedbackTone): void {
  try {
    const ac = getAudioContext();
    if (!ac) return;
    for (const note of TONES[kind]) {
      playNote(ac, note);
    }
  } catch {
    // feedback tone is best-effort; a blocked AudioContext must not break the UI
  }
}

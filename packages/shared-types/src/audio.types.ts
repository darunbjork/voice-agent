import type { AgentReply } from "./agent.types.js";

export type ClientAudioMessage =
  | {
      type: "audio_chunk";
      data: ArrayBuffer;
    }
  | {
      type: "text_input";
      text: string;
    }
  | {
      type: "barge_in";
    }
  | {
      type: "session_end";
    };

export type ServerAudioMessage =
  | {
      type: "transcript_interim";
      text: string;
    }
  | {
      type: "transcript_final";
      text: string;
      /** STT recognition delay: end of the last word → final transcript (ms). */
      latencyMs: number;
      /**
       * How long ago speech ended when this message was sent (ms), so the
       * client can time the turn end of speech → first TTS byte without
       * comparing clocks. Absent for typed input.
       */
      sinceSpeechEndMs?: number;
    }
  | {
      type: "agent_thinking";
    }
  | {
      type: "agent_response";
      reply: AgentReply;
    }
  | {
      type: "tts_chunk";
      audio: ArrayBuffer;
      sequenceNum: number;
    }
  | {
      type: "tts_done";
    }
  | {
      type: "error";
      code: string;
      message: string;
    }
  | {
      type: "session_id";
      sessionId: string;
    };

export type LatencyBreakdown = {
  stt: number;
  llm: number;
  tts: number;
  total: number;
};

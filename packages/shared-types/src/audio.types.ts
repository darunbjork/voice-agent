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
      latencyMs: number;
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

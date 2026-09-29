import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientAudioMessage, ServerAudioMessage } from "@voice-agent/shared-types";

export type ProxyStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

export type TranscriptHandlers = {
  onSessionId?: (sessionId: string) => void;
  onInterim?: (text: string) => void;
  onFinal?: (text: string, latencyMs: number) => void;
  onAgentThinking?: () => void;
  onAgentResponse?: (msg: Extract<ServerAudioMessage, { type: "agent_response" }>) => void;
  onTtsChunk?: (audio: ArrayBuffer, sequenceNum: number) => void;
  onTtsDone?: () => void;
  onError?: (code: string, message: string) => void;
  onMessage?: (msg: ServerAudioMessage) => void;
};

export type UseDeepgramProxyOptions = {
  handlers: TranscriptHandlers;
  maxRetries?: number;
  baseDelayMs?: number;
};

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;

function buildWsUrl(): string {
  const apiBase = import.meta.env.VITE_API_URL;

  if (apiBase && apiBase.length > 0) {
    const url = new URL(apiBase);
    const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${url.host}/api/ws/audio`;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/ws/audio`;
}

export function useDeepgramProxy(options: UseDeepgramProxyOptions) {
  const {
    handlers,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
  } = options;

  const [status, setStatus] = useState<ProxyStatus>("disconnected");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<ClientAudioMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const dispatch = useCallback((msg: ServerAudioMessage) => {
    const h = handlersRef.current;
    h.onMessage?.(msg);

    switch (msg.type) {
      case "session_id":
        setSessionId(msg.sessionId);
        h.onSessionId?.(msg.sessionId);
        break;
      case "transcript_interim":
        h.onInterim?.(msg.text);
        break;
      case "transcript_final":
        h.onFinal?.(msg.text, msg.latencyMs);
        break;
      case "agent_thinking":
        h.onAgentThinking?.();
        break;
      case "agent_response":
        h.onAgentResponse?.(msg);
        break;
      case "tts_chunk":
        h.onTtsChunk?.(msg.audio, msg.sequenceNum);
        break;
      case "tts_done":
        h.onTtsDone?.();
        break;
      case "error":
        setLastError(`${msg.code}: ${msg.message}`);
        h.onError?.(msg.code, msg.message);
        break;
      default: {
        const _exhaustive: never = msg;
        console.warn("[useDeepgramProxy] unhandled message", _exhaustive);
      }
    }
  }, []);

  const connectInternal = useCallback(() => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    intentionalCloseRef.current = false;
    setStatus(retriesRef.current > 0 ? "reconnecting" : "connecting");
    setLastError(null);

    const ws = new WebSocket(buildWsUrl());
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const controller = new AbortController();
    abortRef.current = controller;
    controller.signal.addEventListener(
      "abort",
      () => {
        intentionalCloseRef.current = true;
        clearReconnectTimer();
        try {
          ws.close();
        } catch {
          // close() throws if the socket is already closed
        }
      },
      { once: true },
    );

    ws.onopen = () => {
      retriesRef.current = 0;
      setStatus("connected");

      const pending = pendingRef.current;
      pendingRef.current = [];
      for (const m of pending) {
        ws.send(JSON.stringify(m));
      }
    };

    ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (event.data instanceof ArrayBuffer) {
        if (event.data.byteLength < 4) {
          console.warn("[useDeepgramProxy] undersized binary frame");
          return;
        }
        const view = new DataView(event.data);
        const sequenceNum = view.getUint32(0, false);
        const audio = event.data.slice(4);
        dispatch({ type: "tts_chunk", audio, sequenceNum });
        return;
      }

      try {
        const msg = JSON.parse(event.data) as ServerAudioMessage;
        dispatch(msg);
      } catch {
        console.warn("[useDeepgramProxy] invalid JSON message", event.data);
      }
    };

    ws.onerror = () => {
      setLastError("WebSocket error");
    };

    ws.onclose = () => {
      if (abortRef.current === controller) abortRef.current = null;
      wsRef.current = null;
      setSessionId(null);

      if (intentionalCloseRef.current) {
        setStatus("disconnected");
        return;
      }

      if (retriesRef.current >= maxRetries) {
        setStatus("error");
        setLastError(`Failed after ${maxRetries} reconnect attempts`);
        return;
      }

      const attempt = retriesRef.current;
      const delay = baseDelayMs * Math.pow(2, attempt);
      retriesRef.current = attempt + 1;
      setStatus("reconnecting");

      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(() => {
        connectInternal();
      }, delay);
    };
  }, [dispatch, maxRetries, baseDelayMs, clearReconnectTimer]);

  const connect = useCallback(() => {
    retriesRef.current = 0;
    clearReconnectTimer();
    connectInternal();
  }, [connectInternal, clearReconnectTimer]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    clearReconnectTimer();
    retriesRef.current = 0;
    pendingRef.current = [];

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const endMsg: ClientAudioMessage = { type: "session_end" };
      ws.send(JSON.stringify(endMsg));
    }

    abortRef.current?.abort();
    abortRef.current = null;

    if (ws) {
      try {
        ws.close();
      } catch {
        // close() throws if the socket is already closed
      }
    }
    wsRef.current = null;
    setStatus("disconnected");
    setSessionId(null);
  }, [clearReconnectTimer]);

  const sendAudio = useCallback((chunk: ArrayBuffer) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  }, []);

  const sendMessage = useCallback((msg: ClientAudioMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return;
    }

    if (pendingRef.current.length >= 16) {
      pendingRef.current.shift();
    }
    pendingRef.current.push(msg);
  }, []);

  useEffect(() => {
    return () => {
      intentionalCloseRef.current = true;
      clearReconnectTimer();
      abortRef.current?.abort();
      abortRef.current = null;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [clearReconnectTimer]);

  return {
    status,
    sessionId,
    lastError,
    connect,
    disconnect,
    sendAudio,
    sendMessage,
    isConnected: status === "connected",
  };
}

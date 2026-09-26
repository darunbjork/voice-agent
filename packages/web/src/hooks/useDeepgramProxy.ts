import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientAudioMessage, ServerAudioMessage } from "@voice-agent/shared-types";

export type ProxyStatus = "disconnected" | "connecting" | "connected" | "error";

export type UseDeepgramProxyOptions = {
  onMessage: (msg: ServerAudioMessage) => void;
};

export function useDeepgramProxy(options: UseDeepgramProxyOptions) {
  const { onMessage } = options;
  const [status, setStatus] = useState<ProxyStatus>("disconnected");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.host;
    const ws = new WebSocket(`${protocol}://${host}/api/ws/audio`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as ServerAudioMessage;
        if (msg.type === "session_id") {
          setSessionId(msg.sessionId);
        }
        onMessageRef.current(msg);
      } catch {
        console.warn("[useDeepgramProxy] invalid message", event.data);
      }
    };

    ws.onerror = () => {
      setStatus("error");
    };

    ws.onclose = () => {
      setStatus("disconnected");
      setSessionId(null);
      wsRef.current = null;
    };
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("disconnected");
    setSessionId(null);
  }, []);

  const sendAudio = useCallback((chunk: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(chunk);
    }
  }, []);

  const sendMessage = useCallback((msg: ClientAudioMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  return {
    status,
    sessionId,
    connect,
    disconnect,
    sendAudio,
    sendMessage,
  };
}

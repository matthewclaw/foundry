/**
 * E13 — "drop in" WebSocket client. Carries CONTROL frames only (attached/busy/error)
 * — the engine's actual turn content keeps arriving over the existing SSE feed
 * (sse.ts) exactly like a headless run's, since every interactive turn is folded into
 * the same store/event-catalogue path server-side. This hook only needs to track
 * connection status and expose `send`.
 */
import { useEffect, useRef, useState } from "react";

export type InteractiveStatus = "connecting" | "attached" | "busy" | "error" | "closed";

export interface InteractiveSession {
  status: InteractiveStatus;
  engineSessionId: string | null;
  errorMessage: string | null;
  send: (text: string) => void;
}

interface ServerFrame {
  type: "attached" | "busy" | "error";
  engineSessionId?: string;
  message?: string;
}

function isServerFrame(value: unknown): value is ServerFrame {
  const type = (value as { type?: unknown } | null)?.type;
  return type === "attached" || type === "busy" || type === "error";
}

export function useInteractiveSession(workstreamId: string, enabled: boolean): InteractiveSession {
  const [status, setStatus] = useState<InteractiveStatus>("connecting");
  const [engineSessionId, setEngineSessionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled) return;
    setStatus("connecting");
    setErrorMessage(null);
    setEngineSessionId(null);

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/api/workstreams/${workstreamId}/interactive`);
    socketRef.current = socket;

    socket.onmessage = (event) => {
      let frame: unknown;
      try {
        frame = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (!isServerFrame(frame)) return;
      if (frame.type === "attached") {
        setStatus("attached");
        setEngineSessionId(frame.engineSessionId ?? null);
      } else if (frame.type === "busy") {
        setStatus("busy");
      } else {
        setStatus("error");
        setErrorMessage(frame.message ?? "unknown error");
      }
    };
    socket.onclose = () => setStatus((s) => (s === "error" ? s : "closed"));
    socket.onerror = () => setStatus("error");

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [workstreamId, enabled]);

  return {
    status,
    engineSessionId,
    errorMessage,
    send(text) {
      socketRef.current?.send(JSON.stringify({ type: "send", text }));
    },
  };
}

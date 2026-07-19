/**
 * E13 — "drop in": WebSocket route for a live, multi-turn interactive session attached
 * to a workstream's most recent engine session. Deliberately carries CONTROL frames
 * only (send/busy/error/attached) — the engine's actual turn content (text, tool
 * calls, usage) keeps arriving over the existing SSE feed (routes/feed.ts) exactly as
 * it does for a headless run, since every interactive turn is folded into the same
 * store/event-catalogue path (runtime's supervisor/fold.ts). No new content-rendering
 * pipeline needed on either side.
 */
import type { FastifyInstance } from "fastify";
import type { SocketStream } from "@fastify/websocket";
import type { WorkstreamId } from "@foundry/core";
import type { RouteContext } from "../server.js";

interface ClientFrame {
  type: "send";
  text: string;
}

function isClientFrame(value: unknown): value is ClientFrame {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "send" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

export function registerInteractiveRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get<{ Params: { id: string } }>(
    "/api/workstreams/:id/interactive",
    { websocket: true },
    async (connection: SocketStream, request) => {
      const workstreamId = request.params.id as WorkstreamId;
      const socket = connection.socket;

      let result;
      try {
        result = await ctx.runtime.attachInteractive(workstreamId);
      } catch (err) {
        socket.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
        socket.close();
        return;
      }

      if (!result.ok) {
        socket.send(JSON.stringify({ type: "error", message: result.reason }));
        socket.close();
        return;
      }

      const { handle, engineSessionId } = result;
      socket.send(JSON.stringify({ type: "attached", engineSessionId }));

      socket.on("message", (raw: Buffer) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          socket.send(JSON.stringify({ type: "error", message: "malformed frame (expected JSON)" }));
          return;
        }
        if (!isClientFrame(parsed)) {
          socket.send(JSON.stringify({ type: "error", message: "expected {type:'send', text:string}" }));
          return;
        }
        const sendResult = handle.send(parsed.text);
        if (!sendResult.ok) {
          socket.send(
            sendResult.reason === "busy"
              ? JSON.stringify({ type: "busy" })
              : JSON.stringify({ type: "error", message: sendResult.reason })
          );
        }
      });

      socket.on("close", () => {
        try {
          handle.detach();
        } catch {
          // The store/server may already be shut down by the time a lingering socket's
          // close event fires (e.g. server stopping with clients still connected) —
          // nothing safer to do from this event handler.
        }
      });
    }
  );
}

import { useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "@shared/types";
import { isFixture } from "./api";

export type WsStatus = "connecting" | "live" | "reconnecting" | "fixture";

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15_000;

/**
 * Opens /ws, optionally watches `dir`, dispatches server messages, reconnects
 * with exponential backoff. Returns the connection status for the indicator.
 */
export function useRevSocket(
  dir: string | undefined,
  onMessage: (msg: ServerMessage) => void,
): WsStatus {
  const [status, setStatus] = useState<WsStatus>(
    isFixture() ? "fixture" : "connecting",
  );
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    if (isFixture()) return;

    let ws: WebSocket | null = null;
    let closed = false;
    let backoff = BACKOFF_MIN_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const send = (msg: ClientMessage) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      ws.onopen = () => {
        backoff = BACKOFF_MIN_MS;
        setStatus("live");
        if (dir) send({ type: "watch", dir });
      };
      ws.onmessage = (ev) => {
        try {
          handler.current(JSON.parse(ev.data as string) as ServerMessage);
        } catch {
          /* malformed frame; ignore */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setStatus("reconnecting");
        timer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      if (dir) send({ type: "unwatch", dir });
      ws?.close();
    };
  }, [dir]);

  return status;
}

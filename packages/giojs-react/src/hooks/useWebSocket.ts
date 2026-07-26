/**
 * packages/giojs-react/src/hooks/useWebSocket.ts
 *
 * Thin wrapper around the native WebSocket API. SSR-safe.
 * All hooks are called unconditionally; `isServer` gates side effects.
 * Binary frames are surfaced as ArrayBuffer (binaryType is forced so the
 * browser never hands back a Blob).
 */
import { useState, useEffect, useCallback, useRef } from 'react';

export type WebSocketData = string | ArrayBuffer;

export interface UseWebSocketResult {
  send: (data: string | ArrayBufferLike | ArrayBufferView | Blob) => void;
  lastMessage: WebSocketData | null;
  readyState: number;
  close: () => void;
}

export function useWebSocket(url: string): UseWebSocketResult {
  const isServer = typeof window === 'undefined';
  const wsRef = useRef<WebSocket | null>(null);
  const [lastMessage, setLastMessage] = useState<WebSocketData | null>(null);
  const [readyState, setReadyState] = useState<number>(-1);

  useEffect(() => {
    if (isServer) return;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = (): void => setReadyState(WebSocket.OPEN);
    ws.onclose = (): void => setReadyState(WebSocket.CLOSED);
    ws.onerror = (): void => setReadyState(WebSocket.CLOSED);
    ws.onmessage = (e: MessageEvent<WebSocketData>): void => setLastMessage(e.data);

    return (): void => {
      ws.close();
      wsRef.current = null;
    };
  }, [url, isServer]);

  const send = useCallback(
    (data: string | ArrayBufferLike | ArrayBufferView | Blob): void => {
      if (!isServer && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    },
    [isServer],
  );

  const close = useCallback((): void => {
    if (!isServer) wsRef.current?.close();
  }, [isServer]);

  return { send, lastMessage, readyState, close };
}

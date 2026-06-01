/**
 * packages/giojs-react/src/hooks/useWebSocket.ts
 *
 * Thin wrapper around the native WebSocket API. SSR-safe.
 * All hooks are called unconditionally; `isServer` gates side effects.
 */
import { useState, useEffect, useCallback, useRef } from 'react';

export interface UseWebSocketResult {
  send: (data: string) => void;
  lastMessage: string | null;
  readyState: number;
  close: () => void;
}

export function useWebSocket(url: string): UseWebSocketResult {
  const isServer = typeof window === 'undefined';
  const wsRef = useRef<WebSocket | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [readyState, setReadyState] = useState<number>(-1);

  useEffect(() => {
    if (isServer) return;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = (): void => setReadyState(WebSocket.OPEN);
    ws.onclose = (): void => setReadyState(WebSocket.CLOSED);
    ws.onerror = (): void => setReadyState(WebSocket.CLOSED);
    ws.onmessage = (e: MessageEvent<string>): void => setLastMessage(e.data);

    return (): void => {
      ws.close();
      wsRef.current = null;
    };
  }, [url, isServer]);

  const send = useCallback((data: string): void => {
    if (!isServer && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, [isServer]);

  const close = useCallback((): void => {
    if (!isServer) wsRef.current?.close();
  }, [isServer]);

  return { send, lastMessage, readyState, close };
}

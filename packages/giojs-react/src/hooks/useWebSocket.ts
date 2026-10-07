/**
 * packages/giojs-react/src/hooks/useWebSocket.ts
 *
 * The native WebSocket API with automatic reconnect. SSR-safe: all hooks
 * run unconditionally and `isServer` gates side effects. Binary frames are
 * surfaced as ArrayBuffer (binaryType is forced so the browser never hands
 * back a Blob).
 *
 * Reconnects use exponential backoff with jitter, and stop on unmount, on
 * close(), and on closes that retrying cannot fix: 1000 (the server ended
 * the conversation) and 4000-4499 (the application refused, like an HTTP
 * 4xx - e.g. 4401 from a wsHandler rejecting the session). 1001 (server
 * shutdown or restart), 1006 (network loss), 1011/1012/1013 and 4500-4999
 * retry.
 */
import { useState, useEffect, useCallback, useRef } from 'react';

export type WebSocketData = string | ArrayBuffer;
export type WebSocketSendData = string | ArrayBufferLike | ArrayBufferView | Blob;

export interface ReconnectOptions {
  /** Attempts after a drop before giving up. Default: Infinity. */
  maxAttempts?: number;
  /** Backoff before the first retry. Default: 500 ms. */
  initialDelayMs?: number;
  /** Backoff cap. Default: 30 s. */
  maxDelayMs?: number;
}

export interface UseWebSocketOptions {
  /** Reconnect after an unintended close. Default: true. */
  reconnect?: boolean | ReconnectOptions;
  /**
   * Decide per close whether to reconnect, replacing the default policy
   * (see the module comment). Ignored when reconnect is false.
   */
  shouldReconnect?: (event: CloseEvent) => boolean;
  /**
   * Queue send() calls made while the socket is not open (connecting or
   * reconnecting) and flush them on open, instead of dropping them.
   * `true` keeps up to 100 messages. Default: off.
   */
  queueWhileDisconnected?: boolean | { maxMessages: number };
  protocols?: string | string[];
  /** Every message, in order - lastMessage alone may skip some under React batching. */
  onMessage?: (data: WebSocketData, event: MessageEvent) => void;
  onOpen?: (event: Event) => void;
  onClose?: (event: CloseEvent) => void;
}

export interface UseWebSocketResult {
  /** Send now, or queue it (queueWhileDisconnected). False when dropped. */
  send: (data: WebSocketSendData) => boolean;
  lastMessage: WebSocketData | null;
  /** WebSocket.readyState of the current socket; -1 before one exists (SSR). */
  readyState: number;
  /** Consecutive failed attempts since the last open; 0 while connected. */
  reconnectAttempts: number;
  /** True while waiting to retry after a drop. */
  isReconnecting: boolean;
  /** Close for good (no reconnect) until reconnect() or a new url. */
  close: (code?: number, reason?: string) => void;
  /** Open a fresh connection now, resetting the backoff. */
  reconnect: () => void;
}

const DEFAULT_MAX_QUEUED = 100;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;
const NOT_CREATED = -1;
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** The default reconnect policy for a close the hook did not initiate. */
export function isRetryableClose(code: number): boolean {
  if (code === 1000) return false;
  if (code >= 4000 && code < 4500) return false;
  return true;
}

/**
 * Backoff before retry `attempt` (0-based): exponential, capped, with
 * "equal jitter" - half fixed, half random - so a server restart does not
 * get every client back in the same instant.
 */
export function reconnectDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(maxDelayMs, initialDelayMs * 2 ** attempt);
  return base / 2 + random() * (base / 2);
}

/** Relative URLs (`/chat/lobby`) resolve against the page, ws: or wss: to match. */
function resolveUrl(url: string): string {
  if (/^wss?:\/\//i.test(url)) return url;
  const absolute = new URL(url, window.location.href);
  if (absolute.protocol === 'http:') absolute.protocol = 'ws:';
  else if (absolute.protocol === 'https:') absolute.protocol = 'wss:';
  return absolute.toString();
}

function reconnectSettings(reconnect: UseWebSocketOptions['reconnect']): Required<ReconnectOptions> | null {
  if (reconnect === false) return null;
  const custom = typeof reconnect === 'object' ? reconnect : {};
  return {
    maxAttempts: custom.maxAttempts ?? Infinity,
    initialDelayMs: custom.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs: custom.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  };
}

export function useWebSocket(url: string, options: UseWebSocketOptions = {}): UseWebSocketResult {
  const isServer = typeof window === 'undefined';
  const wsRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<WebSocketSendData[]>([]);
  // Latest options without reconnecting when an inline object changes identity.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [lastMessage, setLastMessage] = useState<WebSocketData | null>(null);
  const [readyState, setReadyState] = useState<number>(NOT_CREATED);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [isReconnecting, setIsReconnecting] = useState(false);
  // Bumped by reconnect() to restart the connection effect.
  const [generation, setGeneration] = useState(0);
  const closeRef = useRef<(code?: number, reason?: string) => void>(() => {});

  useEffect(() => {
    if (isServer) return;
    let disposed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = (): void => {
      const { protocols } = optionsRef.current;
      const ws = new WebSocket(resolveUrl(url), protocols);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      setReadyState(ws.readyState);

      ws.onopen = (event): void => {
        if (wsRef.current !== ws) return;
        attempt = 0;
        setReconnectAttempts(0);
        setIsReconnecting(false);
        setReadyState(OPEN);
        const queued = queueRef.current;
        queueRef.current = [];
        for (const data of queued) ws.send(data);
        optionsRef.current.onOpen?.(event);
      };
      ws.onmessage = (event: MessageEvent<WebSocketData>): void => {
        if (wsRef.current !== ws) return;
        setLastMessage(event.data);
        optionsRef.current.onMessage?.(event.data, event);
      };
      // A failed connection fires error, then close: close decides.
      ws.onclose = (event): void => {
        if (wsRef.current !== ws) return;
        setReadyState(CLOSED);
        optionsRef.current.onClose?.(event);
        const settings = reconnectSettings(optionsRef.current.reconnect);
        const retry =
          !disposed &&
          settings !== null &&
          attempt < settings.maxAttempts &&
          (optionsRef.current.shouldReconnect ?? ((e: CloseEvent) => isRetryableClose(e.code)))(event);
        if (!retry) {
          wsRef.current = null;
          setIsReconnecting(false);
          queueRef.current = [];
          return;
        }
        const delay = reconnectDelay(attempt, settings.initialDelayMs, settings.maxDelayMs);
        attempt += 1;
        setReconnectAttempts(attempt);
        setIsReconnecting(true);
        timer = setTimeout(connect, delay);
      };
    };

    closeRef.current = (code = 1000, reason = ''): void => {
      disposed = true;
      clearTimeout(timer);
      queueRef.current = [];
      setIsReconnecting(false);
      const ws = wsRef.current;
      if (ws === null) return;
      if (ws.readyState === CONNECTING || ws.readyState === OPEN) {
        ws.close(code, reason);
      } else {
        wsRef.current = null;
      }
    };

    connect();
    return (): void => {
      disposed = true;
      clearTimeout(timer);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws !== null) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        if (ws.readyState === CONNECTING || ws.readyState === OPEN) ws.close(1000);
      }
    };
  }, [url, isServer, generation]);

  const send = useCallback(
    (data: WebSocketSendData): boolean => {
      if (isServer) return false;
      const ws = wsRef.current;
      if (ws?.readyState === OPEN) {
        ws.send(data);
        return true;
      }
      const queue = optionsRef.current.queueWhileDisconnected;
      // Nothing to flush into once the hook stopped (close(), or gave up).
      if (queue === undefined || queue === false || ws === null) return false;
      const max = queue === true ? DEFAULT_MAX_QUEUED : queue.maxMessages;
      if (queueRef.current.length >= max) return false;
      queueRef.current.push(data);
      return true;
    },
    [isServer],
  );

  const close = useCallback(
    (code?: number, reason?: string): void => {
      if (!isServer) closeRef.current(code, reason);
    },
    [isServer],
  );

  const reconnect = useCallback((): void => {
    if (isServer) return;
    setReconnectAttempts(0);
    setIsReconnecting(false);
    setGeneration(g => g + 1);
  }, [isServer]);

  return { send, lastMessage, readyState, reconnectAttempts, isReconnecting, close, reconnect };
}

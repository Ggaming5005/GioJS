/**
 * giojs-core/src/context.ts
 *
 * Shared message and context types for the Rust ↔ Node IPC boundary:
 * HTTP render requests/responses, SSE frames, and WebSocket bridge messages.
 */

export interface IPCRequest {
  id: string;
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
  /** True when `body` is base64 (the raw request body was not valid UTF-8). */
  bodyBase64: boolean;
  deploymentId: string;
  locale: string;
}

export interface IPCResponse {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  cacheable: boolean;
  cacheMaxAge: number;
  cacheKey?: string | null;
  /**
   * Request headers this response varies on. Non-empty vary currently makes
   * the response uncacheable and unshared on the Rust side; vary-keyed
   * caching is a later protocol consumer.
   */
  vary?: string[];
  /** Tags for tag-based cache invalidation; stored with the cache entry. */
  cacheTags?: string[];
}

export interface IPCError {
  id: string;
  error: true;
  code: 'RENDER_ERROR' | 'NOT_FOUND' | 'TIMEOUT' | 'INTERNAL';
  message: string;
  stack?: string;
}

export type IPCOutbound = IPCResponse | IPCError;

// ── SSE + WebSocket types ─────────────────────────────────────────────────────

/** Request object handed to route.ts method handlers (and SSE GET handlers). */
export interface GioRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Cookie header parsed into name → value. */
  cookies: Record<string, string>;
  /** Raw request body (UTF-8, or base64 when bodyBase64 is true); null if none. */
  body: string | null;
  bodyBase64: boolean;
  /** Parse the body as JSON. Throws on absent, base64, or malformed bodies. */
  json<T = unknown>(): T;
  locale?: string;
}

/** Server-side handle for a WebSocket connection. Binary frames arrive as Buffer. */
export interface GioSocket {
  readonly id: string;
  readonly routeId: string;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  broadcast(data: string): void;
  on(event: 'message', handler: (data: string | Buffer) => void): void;
  on(event: 'close', handler: (code: number, reason: string) => void): void;
}

// WS IPC messages: Rust → Node (over giojs-ws pipe)
export interface WsConnectMsg  { type: 'ws_connect';    connId: string; routeId: string; addr: string; }
export interface WsMessageMsg  { type: 'ws_message';    connId: string; data: string; isBinary: boolean; }
export interface WsDisconnectMsg { type: 'ws_disconnect'; connId: string; code: number; reason: string; }
export type WsInbound = WsConnectMsg | WsMessageMsg | WsDisconnectMsg;

// WS IPC messages: Node → Rust (over giojs-ws pipe)
export interface WsSendMsg      { type: 'ws_send';      connId: string; data: string; isBinary: boolean; }
export interface WsCloseMsg     { type: 'ws_close';     connId: string; code: number; reason: string; }
export interface WsBroadcastMsg { type: 'ws_broadcast'; routeId: string; data: string; }
export type WsOutbound = WsSendMsg | WsCloseMsg | WsBroadcastMsg;

// SSE messages on the HTTP IPC pipe
export interface SseChunkMsg { type: 'sse_chunk'; id: string; data: string; }
export interface SseDoneMsg  { type: 'sse_done';  id: string; }
export interface SseCloseMsg { type: 'sse_close'; id: string; }

/** Rust → Node: abort an in-flight render (client disconnected or timed out). */
export interface CancelMsg { type: 'cancel'; id: string; }
/** Reserved for streaming SSR (protocol v2+). Not emitted or consumed in v1. */
export interface ChunkMsg { type: 'chunk'; id: string; data: string; }

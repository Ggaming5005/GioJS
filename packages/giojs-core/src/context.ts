export interface IPCRequest {
  id: string;
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
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

/** Subset of IPCRequest for route handlers that don't do SSR. */
export interface GioRequest {
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  locale?: string;
}

/** Server-side handle for a WebSocket connection. */
export interface GioSocket {
  readonly id: string;
  readonly routeId: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  broadcast(data: string): void;
  on(event: 'message', handler: (data: string) => void): void;
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

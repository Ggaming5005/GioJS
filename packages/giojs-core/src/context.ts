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
  /**
   * PPR holes render (additive, protocol stays v3): render the page fully but
   * forward only the chunks after the shell boundary - the shell bytes are
   * discarded because Rust already served them from the cache.
   */
  skipShell?: boolean;
  /**
   * The client's IP, behind any `[server] trusted_proxies` (additive,
   * protocol stays v3 - absent from older servers and static export).
   */
  ip?: string;
  /** 'https' or 'http', as the client used it (proxy-aware). */
  scheme?: string;
  /** The host the client addressed (proxy-aware; absent if none was sent). */
  host?: string;
  /** This request's id - Rust's X-Request-Id, also in every log line. */
  requestId?: string;
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
  /**
   * True when `body` is base64 (a route handler returned a binary Response).
   * Mirrors the request-side flag of the same name.
   */
  bodyBase64?: boolean;
  /**
   * Protocol v3: this response is the head of a streamed render - `body` is
   * empty and 1..n chunk frames follow, terminated by chunk_end.
   */
  streaming?: boolean;
  /**
   * PPR (shell='cache'): this streamed render marks its shell boundary with a
   * shell_end frame; Rust caches everything before it as the static shell.
   */
  pprShell?: boolean;
  /**
   * Set-Cookie values, each sent as its own header (additive, protocol stays
   * v3). Cookies cannot share the single-valued `headers` map: they are not
   * comma-joinable (Expires dates contain commas). Plugins append here too.
   * Page (gSSP) and route.ts cookies arrive here, never in
   * `headers['set-cookie']`; an onResponse plugin strips them with `[]`.
   */
  setCookies?: string[];
  /**
   * The matched route pattern, e.g. "/posts/:id" (additive, protocol stays
   * v3). Rust labels its metrics with it and stores it with cache entries;
   * absent when no route matched. Stamped by ipc.ts, never by renderRoute.
   */
  route?: string;
  /**
   * True on a route.ts handler's response (additive, protocol stays v3).
   * Route handlers own their caching: Rust adds no default Cache-Control
   * to them, whatever their content type.
   */
  routeHandler?: boolean;
}

export interface IPCError {
  id: string;
  error: true;
  code: 'RENDER_ERROR' | 'NOT_FOUND' | 'TIMEOUT' | 'INTERNAL';
  /** The real message in dev; a generic one in production. */
  message: string;
  /** Dev only. */
  stack?: string;
  /**
   * Error reference (additive, protocol stays v3). Logged with the real
   * message and stack, and shown on the production error page instead.
   */
  digest?: string;
  /** The failed request's id, echoed so Rust's error log line carries it. */
  requestId?: string;
  /** The matched route pattern, as on IPCResponse. */
  route?: string;
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
  /**
   * Parse the body as JSON. The request must declare `application/json` (or
   * `application/*+json`): otherwise it throws `UnsupportedMediaTypeError`,
   * which becomes a 415 response unless the handler catches it. Also throws
   * on absent, base64, or malformed bodies. `body` stays available raw.
   */
  json<T = unknown>(): T;
  /**
   * Parse the body as a form: `application/x-www-form-urlencoded` fields as
   * strings, `multipart/form-data` file parts as `File` objects (web-standard
   * FormData). Any other content type throws `UnsupportedMediaTypeError`
   * (415 unless caught); a body that does not parse throws
   * `MalformedBodyError` (400). Bodies above `[server] max_body_bytes` never
   * get here - the server answers 413.
   */
  formData(): Promise<FormData>;
  locale?: string;
  /**
   * The client's IP address. Behind a reverse proxy this is the visitor
   * only when the proxy is listed in gio.toml `[server] trusted_proxies`
   * (otherwise it is the proxy's address) - never read X-Forwarded-For
   * yourself, any client can send it. Absent outside the server (static
   * export).
   */
  ip?: string;
  /** 'https' or 'http', as the client used it (proxy-aware). */
  scheme?: string;
  /**
   * The host the client addressed (proxy-aware, may include a port). It is
   * whatever the client sent unless your proxy pins it: fine for display,
   * never for a security decision.
   */
  host?: string;
  /** Unique per request: the response's X-Request-Id, and on every log line. */
  requestId?: string;
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
/** Streaming SSR body chunk (protocol v3). `data` is always UTF-8 HTML text. */
export interface ChunkMsg { type: 'chunk'; id: string; data: string; }
/** PPR: everything sent before this frame is the cacheable shell. */
export interface ShellEndMsg { type: 'shell_end'; id: string; }
/** Terminates a streamed body. `aborted` marks a render error mid-stream. */
export interface ChunkEndMsg { type: 'chunk_end'; id: string; aborted?: boolean; }

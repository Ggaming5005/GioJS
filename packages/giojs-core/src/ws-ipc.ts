/**
 * giojs-core/src/ws-ipc.ts
 *
 * Second IPC server - WebSocket events. Rust connects to this pipe;
 * messages use the same 4-byte length-prefixed JSON framing as HTTP IPC.
 * Binary WebSocket payloads cross the pipe base64-encoded with
 * `isBinary: true`; text payloads keep the original shape.
 * Node is the server, Rust is the client (same pattern as HTTP IPC).
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { handshakeProof, writeFrame, makeDroppableFrameWriter } from './ipc.ts';
import { logger } from './logger.ts';
import { parseCookies } from './cookies.ts';
import { matchWsHandler, type WsHandlerFn } from './ws-router.ts';
import { assertRoomName, MAX_ROOMS_PER_SOCKET, wsHub } from './ws-hub.ts';
import type { WsConnectMsg, WsInbound, WsOutbound, GioSocket } from './context.ts';

const IS_WINDOWS = process.platform === 'win32';
const WS_WINDOWS_PIPE_PATH = String.raw`\\.\pipe\giojs-ws`;
const DEFAULT_WS_SOCKET_PATH = '.gio/ws.sock';

// Shared instance secret from the Rust supervisor; empty disables auth
// (standalone/test runs).
const WS_IPC_TOKEN = process.env.GIO_IPC_TOKEN ?? '';

export const MAX_WS_IPC_FRAME_BYTES = 64 * 1024 * 1024;

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Close code for a connection its wsHandler rejected (returned false). */
export const WS_REJECTED_CODE = 4401;
/** Close code for a path no route.ts wsHandler matches. */
export const WS_NO_HANDLER_CODE = 4404;
/**
 * Messages held while an async wsHandler is still deciding and has not
 * registered a 'message' listener yet. A client that floods a socket nobody
 * listens to yet is closed (1008) instead of buffered.
 */
export const MAX_HELD_MESSAGES = 256;
/** The same bound in bytes (UTF-8 for text): one socket's held messages. */
export const MAX_HELD_BYTES = 1024 * 1024;
/**
 * Held bytes across every socket of the worker, so max_connections pending
 * sockets cannot add up to max_connections × MAX_HELD_BYTES.
 */
export const MAX_HELD_BYTES_TOTAL = 32 * 1024 * 1024;
/**
 * How long messages wait for a handler that neither listens nor settles.
 * Then they are dropped, and later ones are delivered as for an accepted
 * socket: a handler that keeps running for the connection's lifetime does
 * not hold its client's messages forever.
 */
export const HOLD_TIMEOUT_MS = 10_000;

type MessageHandler = (data: string | Buffer) => void;
type CloseHandler = (code: number, reason: string) => void;

/** The upgrade request's context, as the ws_connect frame carried it. */
export interface WsConnectionContext {
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  ip?: string;
  requestId?: string;
}

export function encodeBinaryPayload(data: Buffer): string {
  return data.toString('base64');
}

export function decodeBinaryPayload(data: string): Buffer | null {
  if (!BASE64_PATTERN.test(data)) return null;
  return Buffer.from(data, 'base64');
}

/**
 * Validate a parsed frame into a WsInbound. Returns null if the discriminant
 * or any per-variant required field is missing or mistyped. Raw parsed JSON
 * is never handed to business logic without validation at this boundary.
 */
export function validateWsInbound(value: unknown): WsInbound | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const msg = value as Record<string, unknown>;

  if (msg['type'] === 'ws_connect') {
    if (typeof msg['connId'] !== 'string') return null;
    if (typeof msg['routeId'] !== 'string') return null;
    if (typeof msg['addr'] !== 'string') return null;
    // The connection context is optional (older servers omit it) but never
    // mistyped: a handler authenticating on headers must see real strings.
    const context: Pick<WsConnectMsg, 'path' | 'query' | 'headers' | 'ip' | 'requestId'> = {};
    for (const key of ['path', 'ip', 'requestId'] as const) {
      const value = msg[key];
      if (value === undefined) continue;
      if (typeof value !== 'string') return null;
      context[key] = value;
    }
    for (const key of ['query', 'headers'] as const) {
      const value = msg[key];
      if (value === undefined) continue;
      if (!isStringRecord(value)) return null;
      context[key] = value;
    }
    return {
      type: 'ws_connect',
      connId: msg['connId'],
      routeId: msg['routeId'],
      addr: msg['addr'],
      ...context,
    };
  }

  if (msg['type'] === 'ws_message') {
    if (typeof msg['connId'] !== 'string') return null;
    if (typeof msg['data'] !== 'string') return null;
    if (typeof msg['isBinary'] !== 'boolean') return null;
    return {
      type: 'ws_message',
      connId: msg['connId'],
      data: msg['data'],
      isBinary: msg['isBinary'],
    };
  }

  if (msg['type'] === 'ws_disconnect') {
    if (typeof msg['connId'] !== 'string') return null;
    if (typeof msg['code'] !== 'number' || !Number.isInteger(msg['code'])) return null;
    if (typeof msg['reason'] !== 'string') return null;
    return {
      type: 'ws_disconnect',
      connId: msg['connId'],
      code: msg['code'],
      reason: msg['reason'],
    };
  }

  return null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(v => typeof v === 'string');
}

/** Held-message bytes shared by every socket of one dispatcher. */
export interface HeldBudget {
  bytes: number;
}

export class GioSocketImpl implements GioSocket {
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly closeHandlers: CloseHandler[] = [];
  private readonly joined = new Set<string>();
  /** Set by close() or the disconnect: nothing more goes out or comes in. */
  private closed = false;
  /** Set once the wsHandler accepted (and Rust was told, see _accept). */
  private accepted = false;
  /**
   * Messages held for an async wsHandler that has not registered a
   * 'message' listener yet; null while messages are delivered directly.
   */
  private held: Array<string | Buffer> | null = null;
  private heldBytes = 0;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseScheduled = false;

  readonly path: string;
  readonly params: Record<string, string>;
  readonly query: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly cookies: Record<string, string>;
  readonly ip?: string;
  readonly requestId?: string;

  constructor(
    public readonly id: string,
    public readonly routeId: string,
    private readonly writeFn: (msg: WsOutbound) => void,
    context: Partial<WsConnectionContext> = {},
    private readonly heldBudget: HeldBudget = { bytes: 0 },
  ) {
    this.path = context.path ?? routeId;
    this.params = context.params ?? {};
    this.query = context.query ?? {};
    this.headers = context.headers ?? {};
    this.cookies = parseCookies(this.headers['cookie']);
    if (context.ip !== undefined) this.ip = context.ip;
    if (context.requestId !== undefined) this.requestId = context.requestId;
  }

  get rooms(): ReadonlySet<string> {
    return this.joined;
  }

  send(data: string | Buffer): void {
    if (this.closed) return;
    if (Buffer.isBuffer(data)) {
      this.writeFn({
        type: 'ws_send',
        connId: this.id,
        data: encodeBinaryPayload(data),
        isBinary: true,
      });
    } else {
      this.writeFn({ type: 'ws_send', connId: this.id, data, isBinary: false });
    }
  }

  close(code: number = 1000, reason: string = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHolding();
    this.writeFn({ type: 'ws_close', connId: this.id, code, reason });
  }

  broadcast(data: string): void {
    this.writeFn({ type: 'ws_broadcast', routeId: this.routeId, data });
  }

  join(room: string): void {
    assertRoomName(room);
    if (this.closed || this.joined.has(room)) return;
    if (this.joined.size >= MAX_ROOMS_PER_SOCKET) {
      throw new RangeError(`a socket can join at most ${MAX_ROOMS_PER_SOCKET} rooms`);
    }
    this.joined.add(room);
    this.writeFn({ type: 'ws_join', connId: this.id, room });
  }

  leave(room: string): void {
    if (!this.joined.delete(room) || this.closed) return;
    this.writeFn({ type: 'ws_leave', connId: this.id, room });
  }

  /**
   * The wsHandler is async and still deciding. Messages that arrive before
   * it registers a 'message' listener are held for that listener; once one
   * exists they are delivered as they come - a handler that awaits its first
   * message (token auth) waits on exactly that.
   */
  _hold(): void {
    if (!this.closed && this.messageHandlers.length === 0) this.held = [];
  }

  /**
   * The wsHandler accepted: tell Rust - until then the connection gets no
   * route or room broadcasts, so a socket about to be rejected never sees
   * one - and deliver what was held, in order.
   */
  _accept(): void {
    if (this.closed || this.accepted) return;
    this.accepted = true;
    this.writeFn({ type: 'ws_accept', connId: this.id });
    this.releaseHeld();
  }

  on(event: 'message', handler: MessageHandler): void;
  on(event: 'close', handler: CloseHandler): void;
  on(event: 'message' | 'close', handler: MessageHandler | CloseHandler): void {
    if (event === 'message') {
      this.messageHandlers.push(handler as MessageHandler);
      // The held messages go to the first listener on a microtask, not from
      // inside on(): the handler finishes the statement that registered it.
      if (this.held !== null && !this.releaseScheduled) {
        this.releaseScheduled = true;
        queueMicrotask(() => this.releaseHeld());
      }
    } else {
      this.closeHandlers.push(handler as CloseHandler);
    }
  }

  // User handlers run inside net socket event listeners; an uncaught throw
  // there would take down the whole SSR worker, so every callback is guarded.
  _dispatchMessage(data: string | Buffer): void {
    if (this.closed) return;
    if (this.held !== null) {
      this.holdMessage(data);
      return;
    }
    for (const h of this.messageHandlers) {
      try {
        h(data);
      } catch (cause) {
        logger.error('ws message handler threw', { connId: this.id, error: String(cause) });
      }
    }
  }

  private holdMessage(data: string | Buffer): void {
    const held = this.held;
    if (held === null) return;
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    if (
      held.length >= MAX_HELD_MESSAGES ||
      this.heldBytes + bytes > MAX_HELD_BYTES ||
      this.heldBudget.bytes + bytes > MAX_HELD_BYTES_TOTAL
    ) {
      this.close(1008, 'too many messages before the connection was accepted');
      return;
    }
    held.push(data);
    this.heldBytes += bytes;
    this.heldBudget.bytes += bytes;
    if (this.holdTimer === null) {
      this.holdTimer = setTimeout(() => this.holdTimedOut(), HOLD_TIMEOUT_MS);
      this.holdTimer.unref?.();
    }
  }

  /** Stop holding and deliver the held messages, in order, to the listeners registered now. */
  private releaseHeld(): void {
    this.releaseScheduled = false;
    const held = this.held;
    this.stopHolding();
    for (const data of held ?? []) {
      if (this.closed) return;
      this._dispatchMessage(data);
    }
  }

  private holdTimedOut(): void {
    this.holdTimer = null;
    if (this.held === null) return;
    logger.warn('wsHandler neither listened nor settled in time - dropping held messages', {
      path: this.path,
      connId: this.id,
      dropped: this.held.length,
      timeoutMs: HOLD_TIMEOUT_MS,
    });
    this.stopHolding();
  }

  private stopHolding(): void {
    this.heldBudget.bytes -= this.heldBytes;
    this.heldBytes = 0;
    this.held = null;
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  _dispatchClose(code: number, reason: string): void {
    // Rust's registry drops the memberships with the connection.
    this.closed = true;
    this.stopHolding();
    this.joined.clear();
    for (const h of this.closeHandlers) {
      try {
        h(code, reason);
      } catch (cause) {
        logger.error('ws close handler threw', { connId: this.id, error: String(cause) });
      }
    }
  }
}

function wsSocketPath(): string {
  // Rust resolves a per-instance path (unique pipe name on Windows) and
  // passes it via env; the fixed fallbacks only apply standalone.
  return (
    process.env['GIO_WS_SOCKET_PATH'] ??
    (IS_WINDOWS ? WS_WINDOWS_PIPE_PATH : DEFAULT_WS_SOCKET_PATH)
  );
}

/**
 * True when `parsed` is a valid `ws_auth` frame carrying the expected proof.
 * The first frame on every WS IPC connection must pass this gate (when a
 * token is configured) before any other message is processed.
 */
/**
 * Payload frames may be dropped under backpressure; control frames
 * (ws_close, ws_accept, ws_join, ws_leave) never are.
 */
export function isDroppableWsFrame(msg: WsOutbound): boolean {
  return msg.type === 'ws_send' || msg.type === 'ws_broadcast' || msg.type === 'ws_room_broadcast';
}

export function wsAuthIsValid(parsed: unknown, token: string): boolean {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const msg = parsed as Record<string, unknown>;
  return msg['type'] === 'ws_auth' && msg['token'] === handshakeProof(token, 'ws');
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Run a connection's wsHandler and apply the accept/reject contract:
 * `false` (returned or resolved) closes with WS_REJECTED_CODE, a throw or
 * rejection closes with 1011, anything else accepts. While an async handler
 * decides, messages wait for its first 'message' listener (see _hold).
 */
function runWsHandler(handler: WsHandlerFn, socket: GioSocketImpl): void {
  const fail = (cause: unknown): void => {
    logger.error('wsHandler threw on connect', {
      path: socket.path,
      connId: socket.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    socket.close(1011, 'internal error');
  };
  const settle = (result: unknown): void => {
    if (result === false) socket.close(WS_REJECTED_CODE, 'unauthorized');
    else socket._accept();
  };
  let result: unknown;
  try {
    result = handler(socket);
  } catch (cause) {
    fail(cause);
    return;
  }
  if (isPromiseLike(result)) {
    socket._hold();
    Promise.resolve(result).then(settle, fail);
  } else {
    settle(result);
  }
}

export interface WsDispatcher {
  /** Apply one validated Rust → Node frame. */
  handle(msg: WsInbound): void;
  /** Rust went away: every connection is gone with it. */
  disconnectAll(code: number, reason: string): void;
  readonly size: number;
}

/**
 * Connection bookkeeping for one WS IPC connection, separate from the pipe
 * so it is testable frame by frame. Handlers are matched with the page
 * routing rules (dynamic segments, catch-alls, route groups) - see
 * matchWsHandler.
 */
export function createWsDispatcher(
  wsHandlers: Map<string, WsHandlerFn>,
  writeOutbound: (msg: WsOutbound) => void,
): WsDispatcher {
  const activeSockets = new Map<string, GioSocketImpl>();
  const heldBudget: HeldBudget = { bytes: 0 };

  function connect(msg: WsConnectMsg): void {
    const path = msg.path ?? msg.routeId;
    const match = matchWsHandler(path, wsHandlers);
    const gioSocket = new GioSocketImpl(
      msg.connId,
      msg.routeId,
      writeOutbound,
      {
        path,
        params: match?.params ?? {},
        query: msg.query ?? {},
        headers: msg.headers ?? {},
        ...(msg.ip !== undefined ? { ip: msg.ip } : {}),
        ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
      },
      heldBudget,
    );
    activeSockets.set(msg.connId, gioSocket);
    if (match === null) {
      logger.debug('ws connection to a path without a wsHandler', { path, connId: msg.connId });
      gioSocket.close(WS_NO_HANDLER_CODE, 'no websocket handler');
      return;
    }
    runWsHandler(match.handler, gioSocket);
  }

  return {
    handle(msg: WsInbound): void {
      if (msg.type === 'ws_connect') {
        connect(msg);
      } else if (msg.type === 'ws_message') {
        const gioSocket = activeSockets.get(msg.connId);
        if (gioSocket === undefined) {
          logger.debug('ws-ipc message for unknown connection', { connId: msg.connId });
          return;
        }
        if (msg.isBinary) {
          const decoded = decodeBinaryPayload(msg.data);
          if (decoded === null) {
            logger.warn('ws-ipc dropping binary frame with invalid base64', {
              connId: msg.connId,
            });
            return;
          }
          gioSocket._dispatchMessage(decoded);
        } else {
          gioSocket._dispatchMessage(msg.data);
        }
      } else {
        const gioSocket = activeSockets.get(msg.connId);
        gioSocket?._dispatchClose(msg.code, msg.reason);
        activeSockets.delete(msg.connId);
      }
    },
    disconnectAll(code: number, reason: string): void {
      for (const [, s] of activeSockets) {
        s._dispatchClose(code, reason);
      }
      activeSockets.clear();
    },
    get size(): number {
      return activeSockets.size;
    },
  };
}

export function createWsIpcServer(wsHandlers: Map<string, WsHandlerFn>): net.Server {
  const server = net.createServer(socket => {
    logger.info('ws-ipc client connected');
    let authed = WS_IPC_TOKEN === '';

    const writeDroppableFrame = makeDroppableFrameWriter(socket);

    // ws_close is a control frame and is never dropped; payload frames may be
    // dropped under backpressure to keep a slow reader from buffering unboundedly.
    function writeOutbound(msg: WsOutbound): void {
      if (isDroppableWsFrame(msg)) {
        writeDroppableFrame(msg);
        return;
      }
      writeFrame(socket, msg);
    }

    const dispatcher = createWsDispatcher(wsHandlers, writeOutbound);
    // broadcast(room, ...) from route handlers goes out on the live,
    // authenticated connection.
    if (authed) wsHub().write = writeOutbound;

    const handler = makeWsFrameHandler(
      (data: Buffer) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString('utf8'));
        } catch (cause) {
          logger.warn('ws-ipc dropping non-JSON frame', { error: String(cause) });
          return;
        }

        if (!authed) {
          if (wsAuthIsValid(parsed, WS_IPC_TOKEN)) {
            authed = true;
            wsHub().write = writeOutbound;
          } else {
            logger.error('ws-ipc first frame failed auth - destroying connection');
            socket.destroy();
          }
          return;
        }

        const msg = validateWsInbound(parsed);
        if (msg === null) {
          logger.warn('ws-ipc dropping malformed frame', { frameBytes: data.byteLength });
          return;
        }

        dispatcher.handle(msg);
      },
      declaredLength => {
        logger.error('ws-ipc frame exceeds max size - destroying connection', {
          frameBytes: declaredLength,
          maxBytes: MAX_WS_IPC_FRAME_BYTES,
        });
        socket.destroy();
      },
    );

    socket.on('data', handler);
    socket.on('error', err => logger.error('ws-ipc socket error', { error: String(err) }));
    socket.on('close', () => {
      logger.info('ws-ipc client disconnected', { activeConnections: dispatcher.size });
      if (wsHub().write === writeOutbound) wsHub().write = null;
      // Rust disconnected - notify all active sockets
      dispatcher.disconnectAll(1001, 'server disconnected');
    });
  });

  const pipePath = wsSocketPath();
  if (!IS_WINDOWS) {
    fs.mkdirSync(path.dirname(pipePath), { recursive: true });
    fs.rmSync(pipePath, { force: true });
  }

  let listening = false;
  server.listen(pipePath, () => {
    listening = true;
    if (!IS_WINDOWS) {
      fs.chmodSync(pipePath, 0o600);
    }
    logger.info('ws-ipc listening', { path: pipePath });
  });

  server.on('error', err => {
    if (!listening) {
      logger.error('ws-ipc failed to start', { error: String(err) });
      process.exit(1);
    }
    logger.error('ws-ipc server error', { error: String(err) });
  });

  return server;
}

/**
 * Returns a `data` event handler that accumulates bytes and calls `onFrame`
 * whenever a complete length-prefixed frame arrives. A declared length above
 * MAX_WS_IPC_FRAME_BYTES aborts via `onOversizedFrame` without allocating.
 */
export function makeWsFrameHandler(
  onFrame: (data: Buffer) => void,
  onOversizedFrame: (declaredLength: number) => void,
): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return function handler(chunk: Buffer): void {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_WS_IPC_FRAME_BYTES) {
        buf = Buffer.alloc(0);
        onOversizedFrame(len);
        return;
      }
      if (buf.length < 4 + len) break;
      const frame = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      onFrame(Buffer.from(frame));
    }
  };
}

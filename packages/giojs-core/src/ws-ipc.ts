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
import { handshakeProof } from './ipc.ts';
import { logger } from './logger.ts';
import type { WsInbound, WsOutbound, GioSocket } from './context.ts';

const IS_WINDOWS = process.platform === 'win32';
const WS_WINDOWS_PIPE_PATH = String.raw`\\.\pipe\giojs-ws`;
const DEFAULT_WS_SOCKET_PATH = '.gio/ws.sock';

// Shared instance secret from the Rust supervisor; empty disables auth
// (standalone/test runs).
const WS_IPC_TOKEN = process.env.GIO_IPC_TOKEN ?? '';

export const MAX_WS_IPC_FRAME_BYTES = 64 * 1024 * 1024;

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type WsHandlerFn = (socket: GioSocket) => void;
type MessageHandler = (data: string | Buffer) => void;
type CloseHandler = (code: number, reason: string) => void;

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
    return {
      type: 'ws_connect',
      connId: msg['connId'],
      routeId: msg['routeId'],
      addr: msg['addr'],
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

class GioSocketImpl implements GioSocket {
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly closeHandlers: CloseHandler[] = [];

  constructor(
    public readonly id: string,
    public readonly routeId: string,
    private readonly writeFn: (msg: WsOutbound) => void,
  ) {}

  send(data: string | Buffer): void {
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
    this.writeFn({ type: 'ws_close', connId: this.id, code, reason });
  }

  broadcast(data: string): void {
    this.writeFn({ type: 'ws_broadcast', routeId: this.routeId, data });
  }

  on(event: 'message', handler: MessageHandler): void;
  on(event: 'close', handler: CloseHandler): void;
  on(event: 'message' | 'close', handler: MessageHandler | CloseHandler): void {
    if (event === 'message') {
      this.messageHandlers.push(handler as MessageHandler);
    } else {
      this.closeHandlers.push(handler as CloseHandler);
    }
  }

  _dispatchMessage(data: string | Buffer): void {
    for (const h of this.messageHandlers) h(data);
  }

  _dispatchClose(code: number, reason: string): void {
    for (const h of this.closeHandlers) h(code, reason);
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
export function wsAuthIsValid(parsed: unknown, token: string): boolean {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const msg = parsed as Record<string, unknown>;
  return msg['type'] === 'ws_auth' && msg['token'] === handshakeProof(token, 'ws');
}

export function createWsIpcServer(wsHandlers: Map<string, WsHandlerFn>): net.Server {
  const server = net.createServer(socket => {
    logger.info('ws-ipc client connected');
    const activeSockets = new Map<string, GioSocketImpl>();
    let authed = WS_IPC_TOKEN === '';

    function writeFrame(msg: WsOutbound): void {
      const json = Buffer.from(JSON.stringify(msg), 'utf8');
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(json.byteLength, 0);
      socket.write(header);
      socket.write(json);
    }

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

        if (msg.type === 'ws_connect') {
          const gioSocket = new GioSocketImpl(msg.connId, msg.routeId, writeFrame);
          activeSockets.set(msg.connId, gioSocket);
          const wsHandler = wsHandlers.get(msg.routeId);
          if (wsHandler !== undefined) wsHandler(gioSocket);

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
      logger.info('ws-ipc client disconnected', { activeConnections: activeSockets.size });
      // Rust disconnected - notify all active sockets
      for (const [, s] of activeSockets) {
        s._dispatchClose(1001, 'server disconnected');
      }
      activeSockets.clear();
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

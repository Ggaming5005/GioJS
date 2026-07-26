/**
 * giojs-core/src/ipc.ts
 *
 * Unix socket / named pipe server for the HTTP IPC bridge. Multiplexes
 * requests over a single persistent connection using a 4-byte
 * length-prefixed JSON protocol. See SPEC.md §5 for the message contract.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { IPCRequest, IPCOutbound, IPCError } from './context.ts';
import type { RouteModule, LayoutEntry } from './router.ts';
import { renderRoute, type RenderExtras, type SseRouteResult } from './ssr.ts';
import type { SseStream } from './sse.ts';
import type { WsHandlerFn } from './ws-router.ts';
import type { NodePluginRegistry } from './plugin.ts';
import { logger } from './logger.ts';

const IS_WINDOWS = process.platform === 'win32';
// Rust resolves a per-instance path (unique pipe name on Windows) and passes
// it via env. The fixed fallbacks only apply when running Node standalone.
const PIPE_PATH =
  process.env.GIO_SOCKET_PATH ??
  (IS_WINDOWS ? String.raw`\\.\pipe\giojs` : '.gio/ipc.sock');

// Per-instance secret shared by the Rust supervisor. Empty (standalone/test
// runs) disables handshake auth.
const IPC_TOKEN = process.env.GIO_IPC_TOKEN ?? '';

const VERSION = '0.1.0';

/**
 * Wire-format version, echoed in READY. Rust refuses the handshake on
 * mismatch so a stale binary can never silently drive a newer worker.
 * Mirrors IPC_PROTOCOL_VERSION in giojs-server/src/ipc.rs.
 */
export const IPC_PROTOCOL_VERSION = 1;

export const MAX_IPC_MESSAGE_SIZE = 64 * 1024 * 1024;

/**
 * Derived handshake proof: sha256(`${token}:${role}`) hex. Each direction
 * sends a role-specific derivation ("ready" from Node, "ack"/"ws" from Rust)
 * instead of the raw token, so a fake endpoint that captures one proof cannot
 * replay it in the other direction. Mirrors giojs-server/src/ipc.rs.
 */
export function handshakeProof(token: string, role: 'ready' | 'ack' | 'ws'): string {
  return createHash('sha256').update(`${token}:${role}`).digest('hex');
}

/** Start the IPC server and wait for Rust to connect. */
export function createIPCServer(
  routes: Map<string, RouteModule>,
  layouts: Map<string, LayoutEntry>,
  wsHandlers: Map<string, WsHandlerFn>,
  registry?: NodePluginRegistry,
  clientScripts?: Map<string, string>,
  extras?: RenderExtras,
): net.Server {
  const routeList = [...routes.keys()].map(pattern => ({
    pattern,
    hasWsHandler: wsHandlers.has(pattern),
  }));

  const server = net.createServer(socket => {
    logger.info('rust connected', { pipe: PIPE_PATH });

    writeFrame(socket, {
      type: 'ready',
      version: VERSION,
      protocol: IPC_PROTOCOL_VERSION,
      // Proves to the client that this endpoint is the real worker.
      token: IPC_TOKEN === '' ? '' : handshakeProof(IPC_TOKEN, 'ready'),
      routes: routeList,
    });

    let ackReceived = false;
    const activeSseCleanups = new Map<string, () => void>();
    const activeRenders = new Map<string, AbortController>();

    async function processFrame(data: Buffer): Promise<void> {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      } catch (parseError) {
        logger.error('failed to parse ipc frame', {
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
        return;
      }

      if (!ackReceived) {
        if (msg['type'] === 'ack') {
          // Only a client that knows the instance token may drive renders —
          // a foreign local process connecting to the pipe is cut off here.
          if (IPC_TOKEN !== '' && msg['token'] !== handshakeProof(IPC_TOKEN, 'ack')) {
            logger.error('ack token mismatch — destroying connection');
            socket.destroy();
            return;
          }
          ackReceived = true;
          logger.info('ack received, ready to serve requests');
        }
        return;
      }

      if (msg['type'] === 'shutdown') {
        logger.info('shutdown requested');
        socket.destroy();
        return;
      }

      // Browser disconnected from SSE — run cleanup
      if (msg['type'] === 'sse_close') {
        if (typeof msg['id'] !== 'string') {
          logger.warn('sse_close frame missing string id');
          return;
        }
        const cleanup = activeSseCleanups.get(msg['id']);
        if (cleanup !== undefined) {
          cleanup();
          activeSseCleanups.delete(msg['id']);
        }
        return;
      }

      // Rust cancelled the request (client disconnect or timeout): abort the
      // in-flight render, or close the SSE stream if it already started.
      if (msg['type'] === 'cancel') {
        if (typeof msg['id'] !== 'string') {
          logger.warn('cancel frame missing string id');
          return;
        }
        const sseCleanup = activeSseCleanups.get(msg['id']);
        if (sseCleanup !== undefined) {
          sseCleanup();
          activeSseCleanups.delete(msg['id']);
          return;
        }
        activeRenders.get(msg['id'])?.abort();
        return;
      }

      const req = validateIPCRequest(msg);
      if (req === null) {
        logger.error('rejecting malformed request frame', { id: msg['id'] });
        if (typeof msg['id'] === 'string') {
          writeFrame(socket, {
            id: msg['id'],
            error: true,
            code: 'INTERNAL',
            message: 'Malformed IPC request',
          } satisfies IPCError);
        }
        return;
      }

      try {
        await handleRequest(req);
      } catch (requestError) {
        logger.error('request handling failed', {
          id: req.id,
          path: req.path,
          error: requestError instanceof Error ? requestError.message : String(requestError),
        });
        writeFrame(socket, {
          id: req.id,
          error: true,
          code: 'INTERNAL',
          message: requestError instanceof Error ? requestError.message : String(requestError),
        } satisfies IPCError);
      }
    }

    async function handleRequest(req: IPCRequest): Promise<void> {
      const abort = new AbortController();
      activeRenders.set(req.id, abort);
      let routeResult;
      try {
        routeResult = await renderRoute(req, routes, layouts, registry, abort.signal, clientScripts, extras);
      } finally {
        activeRenders.delete(req.id);
      }

      if (!isSseResult(routeResult)) {
        writeFrame(socket, routeResult);
        return;
      }

      // Send initial SSE response so Rust switches to streaming mode
      writeFrame(socket, {
        id: req.id,
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        },
        body: '',
        cacheable: false,
        cacheMaxAge: 0,
      } satisfies IPCOutbound);

      const sseStream: SseStream = {
        send(data: unknown, event?: string, id?: string): void {
          let chunk = '';
          if (id !== undefined) chunk += `id: ${id}\n`;
          if (event !== undefined) chunk += `event: ${event}\n`;
          chunk += `data: ${JSON.stringify(data)}\n\n`;
          writeFrame(socket, { type: 'sse_chunk', id: req.id, data: chunk });
        },
        close(): void {
          writeFrame(socket, { type: 'sse_done', id: req.id });
          activeSseCleanups.delete(req.id);
        },
      };

      try {
        const cleanup = routeResult.stream.handler(sseStream);
        activeSseCleanups.set(req.id, cleanup);
      } catch (handlerError) {
        // Headers already sent — terminate the stream instead of erroring
        logger.error('sse handler threw', {
          id: req.id,
          path: req.path,
          error: handlerError instanceof Error ? handlerError.message : String(handlerError),
        });
        writeFrame(socket, { type: 'sse_done', id: req.id });
        activeSseCleanups.delete(req.id);
      }
    }

    const handler = makeFrameHandler(
      data => {
        processFrame(data).catch((frameError: unknown) => {
          logger.error('ipc frame processing failed', {
            error: frameError instanceof Error ? frameError.message : String(frameError),
          });
        });
      },
      {
        maxFrameBytes: MAX_IPC_MESSAGE_SIZE,
        onOversize(declaredLength: number): void {
          logger.error('oversized ipc frame, destroying connection', {
            declaredLength,
            maxFrameBytes: MAX_IPC_MESSAGE_SIZE,
          });
          socket.destroy();
        },
      },
    );

    socket.on('data', handler);
    socket.on('error', socketError => {
      logger.error('ipc socket error', { error: socketError.message });
    });
    socket.on('close', () => {
      logger.info('rust disconnected');
      // Run all pending SSE cleanups on disconnect
      for (const cleanup of activeSseCleanups.values()) cleanup();
      activeSseCleanups.clear();
    });
  });

  let listening = false;

  if (!IS_WINDOWS) {
    fs.mkdirSync(path.dirname(PIPE_PATH), { recursive: true });
    fs.rmSync(PIPE_PATH, { force: true });
  }

  // Restrictive umask closes the window between listen() creating the socket
  // and chmod; permissions are correct from the moment the socket exists.
  const previousUmask = IS_WINDOWS ? null : process.umask(0o177);

  server.listen(PIPE_PATH, () => {
    if (!IS_WINDOWS) {
      fs.chmodSync(PIPE_PATH, 0o600);
      if (previousUmask !== null) process.umask(previousUmask);
    }
    listening = true;
    logger.info('ipc server listening', { pipe: PIPE_PATH });
  });

  server.on('error', serverError => {
    if (!listening) {
      // Startup failure (EADDRINUSE, EACCES, ...) — nothing can recover this.
      logger.error('ipc server failed to start', { error: serverError.message });
      process.exit(1);
    }
    logger.error('ipc server error', { error: serverError.message });
  });

  return server;
}

function isSseResult(result: IPCOutbound | SseRouteResult): result is SseRouteResult {
  return 'type' in result && result.type === 'sse';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(v => typeof v === 'string');
}

/**
 * Validate a parsed frame into an IPCRequest. Returns null if any required
 * field is missing or mistyped. Per the architecture rules, raw parsed JSON is
 * never handed to business logic without validation at this boundary.
 */
export function validateIPCRequest(msg: Record<string, unknown>): IPCRequest | null {
  if (typeof msg['id'] !== 'string') return null;
  if (typeof msg['method'] !== 'string') return null;
  if (typeof msg['path'] !== 'string') return null;
  if (!isStringRecord(msg['params'])) return null;
  if (!isStringRecord(msg['query'])) return null;
  if (!isStringRecord(msg['headers'])) return null;

  const body = msg['body'];
  if (body !== null && body !== undefined && typeof body !== 'string') return null;

  const bodyBase64 = msg['bodyBase64'];
  if (bodyBase64 !== undefined && typeof bodyBase64 !== 'boolean') return null;

  return {
    id: msg['id'],
    method: msg['method'],
    path: msg['path'],
    params: msg['params'],
    query: msg['query'],
    headers: msg['headers'],
    body: body ?? null,
    bodyBase64: bodyBase64 ?? false,
    deploymentId: typeof msg['deploymentId'] === 'string' ? msg['deploymentId'] : '',
    locale: typeof msg['locale'] === 'string' ? msg['locale'] : '',
  };
}

/** Write a length-prefixed JSON frame: [4-byte big-endian uint32][JSON bytes] */
function writeFrame(socket: net.Socket, payload: unknown): void {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(json.byteLength, 0);
  socket.write(header);
  socket.write(json);
}

export interface FrameHandlerOptions {
  maxFrameBytes?: number;
  onOversize?: (declaredLength: number) => void;
}

/**
 * Returns a `data` event handler that accumulates bytes and calls `onFrame`
 * whenever a complete length-prefixed frame arrives. A declared frame length
 * above `maxFrameBytes` triggers `onOversize` and disables the handler — the
 * stream is unrecoverable at that point and the caller must drop the socket.
 */
export function makeFrameHandler(
  onFrame: (data: Buffer) => void,
  options?: FrameHandlerOptions,
): (chunk: Buffer) => void {
  const maxFrameBytes = options?.maxFrameBytes ?? MAX_IPC_MESSAGE_SIZE;
  let buf = Buffer.alloc(0);
  let poisoned = false;

  return function handler(chunk: Buffer) {
    if (poisoned) return;
    buf = Buffer.concat([buf, chunk]);

    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > maxFrameBytes) {
        poisoned = true;
        buf = Buffer.alloc(0);
        options?.onOversize?.(len);
        return;
      }
      if (buf.length < 4 + len) break;
      const frame = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      onFrame(Buffer.from(frame));
    }
  };
}

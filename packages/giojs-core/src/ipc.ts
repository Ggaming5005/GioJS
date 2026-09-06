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
import {
  renderRoute,
  type RenderExtras,
  type SseRouteResult,
  type StreamRenderResult,
} from './ssr.ts';
import type { SseStream } from './sse.ts';
import type { WsHandlerFn } from './ws-router.ts';
import type { NodePluginRegistry } from './plugin.ts';
import type { MiddlewareRules } from './middleware.ts';
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
 * v3 added streaming SSR responses (`streaming: true` head + chunk frames).
 * The PPR fields (shell_end frames, `pprShell`, `skipShell`) are additive
 * within v3 - both sides default them off.
 */
export const IPC_PROTOCOL_VERSION = 3;

export const MAX_IPC_MESSAGE_SIZE = 64 * 1024 * 1024;

/**
 * Unflushed-socket cap for droppable data frames (SSE chunks, WS payloads).
 * A fast producer against a slow reader drops frames past this point instead
 * of buffering unboundedly in Node memory.
 */
export const MAX_BUFFERED_FRAME_BYTES = 8 * 1024 * 1024;

const DROP_WARN_INTERVAL_MS = 5_000;

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
  middleware?: MiddlewareRules,
): net.Server {
  const routeList = [...routes.keys()].map(pattern => ({
    pattern,
    hasWsHandler: wsHandlers.has(pattern),
  }));

  // Live IPC serving opts into streaming; static export never comes through here.
  const renderExtras: RenderExtras = { ...extras, streaming: true };

  const server = net.createServer(socket => {
    logger.info('rust connected', { pipe: PIPE_PATH });

    writeFrame(socket, {
      type: 'ready',
      version: VERSION,
      protocol: IPC_PROTOCOL_VERSION,
      // Proves to the client that this endpoint is the real worker.
      token: IPC_TOKEN === '' ? '' : handshakeProof(IPC_TOKEN, 'ready'),
      routes: routeList,
      // Older servers ignore unknown READY fields, so shipping middleware
      // rules here needs no protocol bump.
      middleware: middleware ?? {},
    });

    let ackReceived = false;
    const activeSseCleanups = new Map<string, () => void>();
    const activeRenders = new Map<string, AbortController>();
    const writeDroppableFrame = makeDroppableFrameWriter(socket);

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
          // Only a client that knows the instance token may drive renders -
          // a foreign local process connecting to the pipe is cut off here.
          if (IPC_TOKEN !== '' && msg['token'] !== handshakeProof(IPC_TOKEN, 'ack')) {
            logger.error('ack token mismatch - destroying connection');
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

      // Browser disconnected from SSE - run cleanup
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
        routeResult = await renderRoute(req, routes, layouts, registry, abort.signal, clientScripts, renderExtras);

        if (isStreamRenderResult(routeResult)) {
          // Head first: Rust registers the chunk stream under this id before
          // any chunk frame can arrive (frames are processed in order). The
          // abort entry stays registered while pumping so a cancel frame
          // mid-stream aborts the React render and stops the pump.
          writeFrame(socket, routeResult.head);
          await pumpRenderStream(socket, req.id, routeResult);
          return;
        }
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
          writeDroppableFrame({ type: 'sse_chunk', id: req.id, data: formatSseEvent(data, event, id) });
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
        // Headers already sent - terminate the stream instead of erroring
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
      // Run all pending SSE cleanups on disconnect. These are user-supplied
      // callbacks running inside a net 'close' listener - a throw here would
      // be an uncaught exception that kills the whole worker.
      for (const cleanup of activeSseCleanups.values()) {
        try {
          cleanup();
        } catch (cause) {
          logger.error('sse cleanup threw on disconnect', { error: String(cause) });
        }
      }
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
      // Startup failure (EADDRINUSE, EACCES, ...) - nothing can recover this.
      logger.error('ipc server failed to start', { error: serverError.message });
      process.exit(1);
    }
    logger.error('ipc server error', { error: serverError.message });
  });

  return server;
}

type RouteResult = IPCOutbound | SseRouteResult | StreamRenderResult;

function isSseResult(result: RouteResult): result is SseRouteResult {
  return 'type' in result && result.type === 'sse';
}

function isStreamRenderResult(result: RouteResult): result is StreamRenderResult {
  return 'type' in result && result.type === 'stream';
}

/** Socket subset needed by the render-stream pump (testable without a pipe). */
export interface StreamFrameSink extends FrameSink {
  destroyed: boolean;
}

const SHELL_FLUSHED: unique symbol = Symbol('shell-flushed');

// A macrotask tick loses to reads of already-enqueued shell bytes (those
// settle in microtasks) but beats the first hole read, which waits on
// Suspense content - that is the shell boundary.
function shellFlushTick(): Promise<typeof SHELL_FLUSHED> {
  return new Promise(resolve => setImmediate(() => resolve(SHELL_FLUSHED)));
}

/**
 * Pump a streaming render's body as chunk frames, then chunk_end. Chunk
 * frames are never dropped under backpressure (unlike SSE) - the HTML must
 * arrive complete - so writes rely on socket buffering; a destroyed socket
 * stops the pump. Chunk data is always UTF-8 text: React's output is UTF-8
 * and the TextDecoder carries split multi-byte sequences across boundaries.
 *
 * PPR: React resolves renderToReadableStream at shell-ready and flushes the
 * complete shell on the first pull, so everything readable before a macrotask
 * tick is the shell. shellBoundary 'mark' emits a shell_end frame there;
 * 'discard' drops everything before it (prefix included) and forwards only
 * the hole chunks. Both passes detect the boundary identically, so a cached
 * shell and a later holes render concatenate without gaps or overlaps as long
 * as the shell renders deterministically (the PPR contract).
 */
export async function pumpRenderStream(
  socket: StreamFrameSink,
  reqId: string,
  render: StreamRenderResult,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = render.stream.getReader();
  const boundary = render.shellBoundary;
  let inShell = boundary !== undefined;
  try {
    if (socket.destroyed) {
      await reader.cancel();
      return;
    }
    if (render.prefix !== '' && boundary !== 'discard') {
      writeFrame(socket, { type: 'chunk', id: reqId, data: render.prefix });
    }
    let pending = reader.read();
    while (true) {
      if (inShell) {
        const raced = await Promise.race([pending, shellFlushTick()]);
        if (raced === SHELL_FLUSHED) {
          inShell = false;
          if (boundary === 'mark') {
            writeFrame(socket, { type: 'shell_end', id: reqId });
          }
        }
      }
      const { done, value } = await pending;
      if (done) break;
      pending = reader.read();
      if (socket.destroyed) {
        await reader.cancel();
        return;
      }
      const data = decoder.decode(value, { stream: true });
      if (data !== '' && !(inShell && boundary === 'discard')) {
        writeFrame(socket, { type: 'chunk', id: reqId, data });
      }
    }
    // A page whose whole output flushed with the shell still marks the
    // boundary, so Rust stores the shell (its holes render is just empty).
    if (inShell && boundary === 'mark') {
      writeFrame(socket, { type: 'shell_end', id: reqId });
    }
    const closing = decoder.decode() + render.suffix;
    if (closing !== '') {
      writeFrame(socket, { type: 'chunk', id: reqId, data: closing });
    }
    writeFrame(socket, { type: 'chunk_end', id: reqId });
  } catch (streamError) {
    // Render error (or abort) mid-stream: headers already went out, so the
    // only possible signal is ending the body early.
    logger.error('streaming render failed mid-stream', {
      id: reqId,
      error: streamError instanceof Error ? streamError.message : String(streamError),
    });
    if (!socket.destroyed) {
      writeFrame(socket, { type: 'chunk_end', id: reqId, aborted: true });
    }
  }
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

  const skipShell = msg['skipShell'];
  if (skipShell !== undefined && typeof skipShell !== 'boolean') return null;

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
    skipShell: skipShell ?? false,
  };
}

/** Structural socket subset, so frame writers are testable without a real socket. */
export interface FrameSink {
  writableLength: number;
  write(data: Buffer): boolean;
}

/** Write a length-prefixed JSON frame: [4-byte big-endian uint32][JSON bytes] */
export function writeFrame(socket: FrameSink, payload: unknown): void {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(json.byteLength, 0);
  socket.write(header);
  socket.write(json);
}

/**
 * Returns a writer for droppable data frames only (SSE chunks, WS payloads).
 * While the socket's unflushed buffer exceeds MAX_BUFFERED_FRAME_BYTES the
 * frame is dropped with a rate-limited warning instead of buffering without
 * bound against a slow reader. Control frames and HTTP responses must go
 * through `writeFrame` directly - they are never dropped.
 */
export function makeDroppableFrameWriter(socket: FrameSink): (payload: unknown) => boolean {
  let lastDropWarnAt = 0;
  return function writeDroppableFrame(payload: unknown): boolean {
    if (socket.writableLength > MAX_BUFFERED_FRAME_BYTES) {
      const now = Date.now();
      if (now - lastDropWarnAt >= DROP_WARN_INTERVAL_MS) {
        lastDropWarnAt = now;
        logger.warn('ipc write buffer full - dropping data frame', {
          bufferedBytes: socket.writableLength,
          maxBufferedBytes: MAX_BUFFERED_FRAME_BYTES,
        });
      }
      return false;
    }
    writeFrame(socket, payload);
    return true;
  };
}

/**
 * Build one SSE event in wire format. CR/LF are stripped from the id and
 * event fields - embedded newlines would otherwise inject extra fields into
 * the event stream. The data line is JSON, which never spans lines.
 */
export function formatSseEvent(data: unknown, event?: string, id?: string): string {
  let chunk = '';
  if (id !== undefined) chunk += `id: ${id.replace(/[\r\n]/g, '')}\n`;
  if (event !== undefined) chunk += `event: ${event.replace(/[\r\n]/g, '')}\n`;
  chunk += `data: ${JSON.stringify(data)}\n\n`;
  return chunk;
}

export interface FrameHandlerOptions {
  maxFrameBytes?: number;
  onOversize?: (declaredLength: number) => void;
}

/**
 * Returns a `data` event handler that accumulates bytes and calls `onFrame`
 * whenever a complete length-prefixed frame arrives. A declared frame length
 * above `maxFrameBytes` triggers `onOversize` and disables the handler - the
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

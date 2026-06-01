import net from 'node:net';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import type { IPCRequest, IPCOutbound, IPCError } from './context.ts';
import type { RouteModule, LayoutEntry } from './router.ts';
import { renderRoute, type SseRouteResult } from './ssr.ts';
import type { SseStream } from './sse.ts';
import type { WsHandlerFn } from './ws-router.ts';
import type { NodePluginRegistry } from './plugin.ts';

const IS_WINDOWS = process.platform === 'win32';
const PIPE_PATH = IS_WINDOWS
  ? String.raw`\\.\pipe\giojs`
  : (process.env.GIO_SOCKET_PATH ?? '.gio/ipc.sock');

const VERSION = '0.1.0';

/** Start the IPC server and wait for Rust to connect. */
export function createIPCServer(
  routes: Map<string, RouteModule>,
  layouts: Map<string, LayoutEntry>,
  wsHandlers: Map<string, WsHandlerFn>,
  registry?: NodePluginRegistry,
): net.Server {
  const routeList = [...routes.keys()].map(pattern => ({
    pattern,
    hasWsHandler: wsHandlers.has(pattern),
  }));

  const server = net.createServer(socket => {
    console.log('[ipc] Rust connected');

    writeFrame(socket, { type: 'ready', version: VERSION, routes: routeList });

    let ackReceived = false;
    const activeSseCleanups = new Map<string, () => void>();

    const handler = makeFrameHandler(async (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      } catch (e) {
        console.error('[ipc] Failed to parse frame', e);
        return;
      }

      if (!ackReceived) {
        if (msg['type'] === 'ack') {
          ackReceived = true;
          console.log('[ipc] ACK received, ready to serve requests');
        }
        return;
      }

      if (msg['type'] === 'shutdown') {
        console.log('[ipc] Shutdown requested');
        socket.destroy();
        return;
      }

      // Browser disconnected from SSE — run cleanup
      if (msg['type'] === 'sse_close') {
        const reqId = msg['id'] as string;
        const cleanup = activeSseCleanups.get(reqId);
        if (cleanup !== undefined) {
          cleanup();
          activeSseCleanups.delete(reqId);
        }
        return;
      }

      const req = validateIPCRequest(msg);
      if (req === null) {
        console.error('[ipc] rejecting malformed request frame', msg['id']);
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

      const routeResult = await renderRoute(req, routes, layouts, registry);

      if (isSseResult(routeResult)) {
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

        const cleanup = routeResult.stream.handler(sseStream);
        activeSseCleanups.set(req.id, cleanup);
      } else {
        writeFrame(socket, routeResult);
      }
    });

    socket.on('data', handler);
    socket.on('error', err => console.error('[ipc] socket error', err));
    socket.on('close', () => {
      console.log('[ipc] Rust disconnected');
      // Run all pending SSE cleanups on disconnect
      for (const cleanup of activeSseCleanups.values()) cleanup();
      activeSseCleanups.clear();
    });
  });

  if (!IS_WINDOWS) {
    fs.mkdirSync('.gio', { recursive: true });
  }

  server.listen(PIPE_PATH, () => {
    console.log(`[ipc] listening on ${PIPE_PATH}`);
    if (!IS_WINDOWS) {
      fs.chmodSync(PIPE_PATH, 0o600);
    }
  });

  server.on('error', err => {
    console.error('[ipc] server error', err);
    process.exit(1);
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
function validateIPCRequest(msg: Record<string, unknown>): IPCRequest | null {
  if (typeof msg['id'] !== 'string') return null;
  if (typeof msg['method'] !== 'string') return null;
  if (typeof msg['path'] !== 'string') return null;
  if (!isStringRecord(msg['params'])) return null;
  if (!isStringRecord(msg['query'])) return null;
  if (!isStringRecord(msg['headers'])) return null;

  const body = msg['body'];
  if (body !== null && body !== undefined && typeof body !== 'string') return null;

  return {
    id: msg['id'],
    method: msg['method'],
    path: msg['path'],
    params: msg['params'],
    query: msg['query'],
    headers: msg['headers'],
    body: body ?? null,
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

/**
 * Returns a `data` event handler that accumulates bytes and calls `onFrame`
 * whenever a complete length-prefixed frame arrives.
 */
function makeFrameHandler(
  onFrame: (data: Buffer) => void,
): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);

  return function handler(chunk: Buffer) {
    buf = Buffer.concat([buf, chunk]);

    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      const frame = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      onFrame(Buffer.from(frame));
    }
  };
}

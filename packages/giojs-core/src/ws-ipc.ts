/**
 * giojs-core/src/ws-ipc.ts
 *
 * Second IPC server — WebSocket events. Rust connects to this pipe;
 * messages use the same 4-byte length-prefixed JSON framing as HTTP IPC.
 * Node is the server, Rust is the client (same pattern as HTTP IPC).
 */
import net from 'node:net';
import { Buffer } from 'node:buffer';
import type { WsInbound, WsOutbound, GioSocket } from './context.ts';

const IS_WINDOWS = process.platform === 'win32';
const WS_PIPE_PATH = IS_WINDOWS
  ? String.raw`\\.\pipe\giojs-ws`
  : (process.env.GIO_WS_SOCKET_PATH ?? '/tmp/giojs-ws.sock');

type WsHandlerFn = (socket: GioSocket) => void;
type MessageHandler = (data: string) => void;
type CloseHandler = (code: number, reason: string) => void;

class GioSocketImpl implements GioSocket {
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly closeHandlers: CloseHandler[] = [];

  constructor(
    public readonly id: string,
    public readonly routeId: string,
    private readonly writeFn: (msg: WsOutbound) => void,
  ) {}

  send(data: string): void {
    this.writeFn({ type: 'ws_send', connId: this.id, data, isBinary: false });
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

  _dispatchMessage(data: string): void {
    for (const h of this.messageHandlers) h(data);
  }

  _dispatchClose(code: number, reason: string): void {
    for (const h of this.closeHandlers) h(code, reason);
  }
}

export function createWsIpcServer(wsHandlers: Map<string, WsHandlerFn>): net.Server {
  const server = net.createServer(socket => {
    const activeSockets = new Map<string, GioSocketImpl>();

    function writeFrame(msg: WsOutbound): void {
      const json = Buffer.from(JSON.stringify(msg), 'utf8');
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(json.byteLength, 0);
      socket.write(header);
      socket.write(json);
    }

    const handler = makeWsFrameHandler((data: Buffer) => {
      let msg: WsInbound;
      try {
        msg = JSON.parse(data.toString('utf8')) as WsInbound;
      } catch {
        return;
      }

      if (msg.type === 'ws_connect') {
        const gioSocket = new GioSocketImpl(msg.connId, msg.routeId, writeFrame);
        activeSockets.set(msg.connId, gioSocket);
        const wsHandler = wsHandlers.get(msg.routeId);
        if (wsHandler !== undefined) wsHandler(gioSocket);

      } else if (msg.type === 'ws_message') {
        activeSockets.get(msg.connId)?._dispatchMessage(msg.data);

      } else if (msg.type === 'ws_disconnect') {
        const gioSocket = activeSockets.get(msg.connId);
        gioSocket?._dispatchClose(msg.code, msg.reason);
        activeSockets.delete(msg.connId);
      }
    });

    socket.on('data', handler);
    socket.on('error', err => console.error('[ws-ipc] socket error', err));
    socket.on('close', () => {
      // Rust disconnected — notify all active sockets
      for (const [, s] of activeSockets) {
        s._dispatchClose(1001, 'server disconnected');
      }
      activeSockets.clear();
    });
  });

  server.listen(WS_PIPE_PATH, () => {
    console.log(`[ws-ipc] listening on ${WS_PIPE_PATH}`);
  });

  server.on('error', err => console.error('[ws-ipc] server error', err));
  return server;
}

function makeWsFrameHandler(onFrame: (data: Buffer) => void): (chunk: Buffer) => void {
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

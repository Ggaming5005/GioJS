/**
 * packages/giojs-core/src/ws-ipc.test.ts
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { describe, it, expect, vi } from 'vitest';
import type { GioSocket, WsOutbound } from './context.ts';
import {
  GioSocketImpl,
  HOLD_TIMEOUT_MS,
  MAX_HELD_BYTES,
  MAX_HELD_BYTES_TOTAL,
  MAX_HELD_MESSAGES,
  MAX_WS_IPC_FRAME_BYTES,
  WS_NO_HANDLER_CODE,
  WS_REJECTED_CODE,
  createWsDispatcher,
  createWsIpcServer,
  decodeBinaryPayload,
  encodeBinaryPayload,
  isDroppableWsFrame,
  makeWsFrameHandler,
  validateWsInbound,
  wsAuthIsValid,
} from './ws-ipc.ts';
import { handshakeProof } from './ipc.ts';
import { broadcast, MAX_ROOMS_PER_SOCKET, MAX_ROOM_NAME_BYTES, wsHub } from './ws-hub.ts';
import { registerFailedRouteModule, type WsHandlerFn } from './ws-router.ts';
import type { HandlerEntry } from './router.ts';
import { logger } from './logger.ts';

describe('isDroppableWsFrame', () => {
  it('marks payload frames droppable under backpressure', () => {
    expect(isDroppableWsFrame({ type: 'ws_send', connId: 'c1', data: 'x', isBinary: false })).toBe(true);
    expect(isDroppableWsFrame({ type: 'ws_broadcast', routeId: 'r1', data: 'x' })).toBe(true);
  });

  it('never marks the ws_close and ws_accept control frames droppable', () => {
    expect(isDroppableWsFrame({ type: 'ws_close', connId: 'c1', code: 1000, reason: '' })).toBe(false);
    expect(isDroppableWsFrame({ type: 'ws_accept', connId: 'c1' })).toBe(false);
  });
});

describe('wsAuthIsValid', () => {
  it('accepts a ws_auth frame carrying the ws-role proof', () => {
    const frame = { type: 'ws_auth', token: handshakeProof('secret', 'ws') };
    expect(wsAuthIsValid(frame, 'secret')).toBe(true);
  });

  it('rejects wrong proofs, wrong roles, and malformed frames', () => {
    expect(wsAuthIsValid({ type: 'ws_auth', token: 'nope' }, 'secret')).toBe(false);
    // Proof derived for a different role must not authenticate the WS pipe.
    expect(
      wsAuthIsValid({ type: 'ws_auth', token: handshakeProof('secret', 'ack') }, 'secret'),
    ).toBe(false);
    expect(wsAuthIsValid({ type: 'ws_connect', token: handshakeProof('secret', 'ws') }, 'secret')).toBe(false);
    expect(wsAuthIsValid(null, 'secret')).toBe(false);
    expect(wsAuthIsValid('ws_auth', 'secret')).toBe(false);
  });
});

// ── GioSocketImpl tests ───────────────────────────────────────────────────────
// We test GioSocketImpl indirectly by constructing it via ws-ipc internals.
// Since GioSocketImpl is not exported, we test through the GioSocket interface
// by simulating the write function.

interface TestSocket {
  readonly id: string;
  readonly routeId: string;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  broadcast(data: string): void;
  on(
    event: 'message' | 'close',
    handler: ((data: string | Buffer) => void) | ((code: number, reason: string) => void),
  ): void;
  _dispatchMessage(data: string | Buffer): void;
  _dispatchClose(code: number, reason: string): void;
}

function makeTestSocket(writeFn: (msg: WsOutbound) => void): TestSocket {
  // Replicate GioSocketImpl inline so we can test it without exporting the class.
  const messageHandlers: Array<(data: string | Buffer) => void> = [];
  const closeHandlers: Array<(code: number, reason: string) => void> = [];

  const socket: TestSocket = {
    id: 'test-conn-id',
    routeId: '/chat',

    send(data: string | Buffer): void {
      if (Buffer.isBuffer(data)) {
        writeFn({
          type: 'ws_send',
          connId: 'test-conn-id',
          data: encodeBinaryPayload(data),
          isBinary: true,
        });
      } else {
        writeFn({ type: 'ws_send', connId: 'test-conn-id', data, isBinary: false });
      }
    },

    close(code = 1000, reason = ''): void {
      writeFn({ type: 'ws_close', connId: 'test-conn-id', code, reason });
    },

    broadcast(data: string): void {
      writeFn({ type: 'ws_broadcast', routeId: '/chat', data });
    },

    on(event: 'message' | 'close', handler: ((data: string | Buffer) => void) | ((code: number, reason: string) => void)): void {
      if (event === 'message') {
        messageHandlers.push(handler as (data: string | Buffer) => void);
      } else {
        closeHandlers.push(handler as (code: number, reason: string) => void);
      }
    },

    _dispatchMessage(data: string | Buffer): void {
      for (const h of messageHandlers) h(data);
    },

    _dispatchClose(code: number, reason: string): void {
      for (const h of closeHandlers) h(code, reason);
    },
  };

  return socket;
}

describe('GioSocket interface', () => {
  it('send formats ws_send frame correctly', () => {
    const writes: WsOutbound[] = [];
    const socket = makeTestSocket(msg => writes.push(msg));

    socket.send('hello world');

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      type: 'ws_send',
      connId: 'test-conn-id',
      data: 'hello world',
      isBinary: false,
    });
  });

  it('send encodes Buffer payload as base64 with isBinary flag', () => {
    const writes: WsOutbound[] = [];
    const socket = makeTestSocket(msg => writes.push(msg));
    const payload = Buffer.from([0xff, 0x00, 0x88]);

    socket.send(payload);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      type: 'ws_send',
      connId: 'test-conn-id',
      data: payload.toString('base64'),
      isBinary: true,
    });
  });

  it('broadcast formats ws_broadcast with routeId', () => {
    const writes: WsOutbound[] = [];
    const socket = makeTestSocket(msg => writes.push(msg));

    socket.broadcast('hello everyone');

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      type: 'ws_broadcast',
      routeId: '/chat',
      data: 'hello everyone',
    });
  });

  it('close formats ws_close with code and reason', () => {
    const writes: WsOutbound[] = [];
    const socket = makeTestSocket(msg => writes.push(msg));

    socket.close(1001, 'going away');

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      type: 'ws_close',
      connId: 'test-conn-id',
      code: 1001,
      reason: 'going away',
    });
  });

  it('ws_disconnect dispatches close handlers on active socket', () => {
    const writes: WsOutbound[] = [];
    const socket = makeTestSocket(msg => writes.push(msg));

    const closeHandler = vi.fn();
    socket.on('close', closeHandler);
    socket._dispatchClose(1000, 'normal');

    expect(closeHandler).toHaveBeenCalledWith(1000, 'normal');
  });

  it('a throwing message handler is contained and later handlers still run', () => {
    const socket = new GioSocketImpl('conn-1', '/chat', () => {});
    const secondHandler = vi.fn();
    socket.on('message', () => {
      throw new Error('user handler bug');
    });
    socket.on('message', secondHandler);

    expect(() => socket._dispatchMessage('payload')).not.toThrow();
    expect(secondHandler).toHaveBeenCalledWith('payload');
  });

  it('a throwing close handler is contained and later handlers still run', () => {
    const socket = new GioSocketImpl('conn-1', '/chat', () => {});
    const secondHandler = vi.fn();
    socket.on('close', () => {
      throw new Error('user close handler bug');
    });
    socket.on('close', secondHandler);

    expect(() => socket._dispatchClose(1006, 'abnormal')).not.toThrow();
    expect(secondHandler).toHaveBeenCalledWith(1006, 'abnormal');
  });
});

describe('validateWsInbound', () => {
  it('accepts a well-formed ws_connect', () => {
    const msg = validateWsInbound({
      type: 'ws_connect',
      connId: 'c1',
      routeId: '/chat',
      addr: '127.0.0.1:1234',
    });
    expect(msg).toEqual({
      type: 'ws_connect',
      connId: 'c1',
      routeId: '/chat',
      addr: '127.0.0.1:1234',
    });
  });

  it('accepts a well-formed ws_message', () => {
    const msg = validateWsInbound({
      type: 'ws_message',
      connId: 'c1',
      data: 'hello',
      isBinary: false,
    });
    expect(msg).toEqual({
      type: 'ws_message',
      connId: 'c1',
      data: 'hello',
      isBinary: false,
    });
  });

  it('accepts a well-formed ws_disconnect', () => {
    const msg = validateWsInbound({
      type: 'ws_disconnect',
      connId: 'c1',
      code: 1000,
      reason: 'normal',
    });
    expect(msg).toEqual({
      type: 'ws_disconnect',
      connId: 'c1',
      code: 1000,
      reason: 'normal',
    });
  });

  it('rejects non-object values', () => {
    expect(validateWsInbound(null)).toBeNull();
    expect(validateWsInbound('ws_connect')).toBeNull();
    expect(validateWsInbound(42)).toBeNull();
    expect(validateWsInbound(['ws_connect'])).toBeNull();
  });

  it('rejects unknown discriminant', () => {
    expect(validateWsInbound({ type: 'ws_send', connId: 'c1' })).toBeNull();
    expect(validateWsInbound({ connId: 'c1' })).toBeNull();
  });

  it('rejects ws_connect with missing or mistyped fields', () => {
    expect(validateWsInbound({ type: 'ws_connect', connId: 'c1', routeId: '/chat' })).toBeNull();
    expect(
      validateWsInbound({ type: 'ws_connect', connId: 7, routeId: '/chat', addr: 'a' }),
    ).toBeNull();
  });

  it('accepts the optional connection context of ws_connect', () => {
    const msg = validateWsInbound({
      type: 'ws_connect',
      connId: 'c1',
      routeId: '/chat/lobby',
      addr: '203.0.113.9:0',
      path: '/chat/lobby',
      query: { token: 't' },
      headers: { cookie: 'sid=1' },
      ip: '203.0.113.9',
      requestId: 'req-1',
    });
    expect(msg).toMatchObject({
      path: '/chat/lobby',
      query: { token: 't' },
      headers: { cookie: 'sid=1' },
      ip: '203.0.113.9',
      requestId: 'req-1',
    });
  });

  it('rejects a ws_connect whose connection context is mistyped', () => {
    const base = { type: 'ws_connect', connId: 'c1', routeId: '/chat', addr: 'a' };
    expect(validateWsInbound({ ...base, headers: { cookie: 1 } })).toBeNull();
    expect(validateWsInbound({ ...base, query: 'a=1' })).toBeNull();
    expect(validateWsInbound({ ...base, ip: 4 })).toBeNull();
    expect(validateWsInbound({ ...base, requestId: null })).toBeNull();
  });

  it('rejects ws_message with missing or mistyped fields', () => {
    expect(validateWsInbound({ type: 'ws_message', connId: 'c1', data: 'x' })).toBeNull();
    expect(
      validateWsInbound({ type: 'ws_message', connId: 'c1', data: 5, isBinary: false }),
    ).toBeNull();
    expect(
      validateWsInbound({ type: 'ws_message', connId: 'c1', data: 'x', isBinary: 'yes' }),
    ).toBeNull();
  });

  it('rejects ws_disconnect with non-integer code', () => {
    expect(
      validateWsInbound({ type: 'ws_disconnect', connId: 'c1', code: '1000', reason: '' }),
    ).toBeNull();
    expect(
      validateWsInbound({ type: 'ws_disconnect', connId: 'c1', code: 1.5, reason: '' }),
    ).toBeNull();
  });
});

describe('binary payload encoding', () => {
  it('round-trips arbitrary non-UTF-8 bytes', () => {
    const raw = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const encoded = encodeBinaryPayload(raw);
    const decoded = decodeBinaryPayload(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded).toEqual(raw);
  });

  it('encodes known vectors with padding', () => {
    expect(encodeBinaryPayload(Buffer.from('M'))).toBe('TQ==');
    expect(encodeBinaryPayload(Buffer.from('Ma'))).toBe('TWE=');
    expect(encodeBinaryPayload(Buffer.from('Man'))).toBe('TWFu');
  });

  it('rejects strings that are not valid base64', () => {
    expect(decodeBinaryPayload('TWF')).toBeNull();
    expect(decodeBinaryPayload('TW!u')).toBeNull();
    expect(decodeBinaryPayload('T=Fu')).toBeNull();
    expect(decodeBinaryPayload('TWE=TWFu')).toBeNull();
  });

  it('accepts the empty payload', () => {
    expect(decodeBinaryPayload('')).toEqual(Buffer.alloc(0));
  });
});

function frame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(json.byteLength, 0);
  return Buffer.concat([header, json]);
}

describe('makeWsFrameHandler', () => {
  it('reassembles a frame split across chunks', () => {
    const frames: Buffer[] = [];
    const oversized = vi.fn();
    const handler = makeWsFrameHandler(data => frames.push(data), oversized);

    const wire = frame({ type: 'ws_message', connId: 'c1', data: 'hi', isBinary: false });
    handler(wire.subarray(0, 3));
    expect(frames).toHaveLength(0);
    handler(wire.subarray(3, 10));
    expect(frames).toHaveLength(0);
    handler(wire.subarray(10));

    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]?.toString('utf8') ?? '')).toEqual({
      type: 'ws_message',
      connId: 'c1',
      data: 'hi',
      isBinary: false,
    });
    expect(oversized).not.toHaveBeenCalled();
  });

  it('emits multiple frames arriving in one chunk', () => {
    const frames: Buffer[] = [];
    const handler = makeWsFrameHandler(data => frames.push(data), vi.fn());

    const wire = Buffer.concat([
      frame({ type: 'ws_disconnect', connId: 'a', code: 1000, reason: '' }),
      frame({ type: 'ws_disconnect', connId: 'b', code: 1001, reason: '' }),
    ]);
    handler(wire);

    expect(frames).toHaveLength(2);
  });

  it('rejects a declared length above the max without allocating', () => {
    const frames: Buffer[] = [];
    const oversized = vi.fn();
    const handler = makeWsFrameHandler(data => frames.push(data), oversized);

    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(MAX_WS_IPC_FRAME_BYTES + 1, 0);
    handler(header);

    expect(frames).toHaveLength(0);
    expect(oversized).toHaveBeenCalledWith(MAX_WS_IPC_FRAME_BYTES + 1);
  });
});

describe.skipIf(process.platform === 'win32')('createWsIpcServer over Unix socket', () => {
  it('listens with 0600 permissions and round-trips a binary message', async () => {
    const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'giojs-ws-'));
    const sockPath = nodePath.join(tmpDir, 'ws.sock');
    process.env['GIO_WS_SOCKET_PATH'] = sockPath;

    const received: Array<string | Buffer> = [];
    const wsHandlers = new Map<string, (socket: GioSocket) => void>();
    wsHandlers.set('/chat', socket => {
      socket.on('message', data => {
        received.push(data);
        socket.send(Buffer.from([0x01, 0xff]));
      });
    });

    const server = createWsIpcServer(wsHandlers);
    try {
      await once(server, 'listening');
      expect(fs.statSync(sockPath).mode & 0o777).toBe(0o600);

      const client = net.connect(sockPath);
      await once(client, 'connect');

      let clientBuf = Buffer.alloc(0);
      const outboundFrames: WsOutbound[] = [];
      // The accept, then the handler's reply.
      const outboundPromise = new Promise<WsOutbound[]>(resolve => {
        client.on('data', (chunk: Buffer) => {
          clientBuf = Buffer.concat([clientBuf, chunk]);
          while (clientBuf.length >= 4) {
            const len = clientBuf.readUInt32BE(0);
            if (clientBuf.length < 4 + len) return;
            outboundFrames.push(JSON.parse(clientBuf.subarray(4, 4 + len).toString('utf8')) as WsOutbound);
            clientBuf = clientBuf.subarray(4 + len);
            if (outboundFrames.length === 2) resolve(outboundFrames);
          }
        });
      });

      const inboundPayload = Buffer.from([0xff, 0x00, 0x88]);
      client.write(
        frame({ type: 'ws_connect', connId: 'c1', routeId: '/chat', addr: '127.0.0.1:9' }),
      );
      client.write(
        frame({
          type: 'ws_message',
          connId: 'c1',
          data: inboundPayload.toString('base64'),
          isBinary: true,
        }),
      );

      const outbound = await outboundPromise;
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(inboundPayload);
      expect(outbound).toEqual([
        { type: 'ws_accept', connId: 'c1' },
        {
          type: 'ws_send',
          connId: 'c1',
          data: Buffer.from([0x01, 0xff]).toString('base64'),
          isBinary: true,
        },
      ]);

      client.destroy();
    } finally {
      server.close();
      delete process.env['GIO_WS_SOCKET_PATH'];
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Connection dispatcher: routing, context, accept/reject, rooms ──────────

function connectFrame(connId: string, path: string, extra: Record<string, unknown> = {}) {
  return { type: 'ws_connect' as const, connId, routeId: path, addr: '127.0.0.1:9', path, ...extra };
}

function harness(handlers: Record<string, WsHandlerFn>) {
  const writes: WsOutbound[] = [];
  const dispatcher = createWsDispatcher(new Map(Object.entries(handlers)), msg => writes.push(msg));
  return { writes, dispatcher };
}

function messageFrame(connId: string, data: string) {
  return { type: 'ws_message' as const, connId, data, isBinary: false };
}

const ACCEPT = (connId: string): WsOutbound => ({ type: 'ws_accept', connId });

/** Let an async wsHandler settle. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('ws dispatcher routing', () => {
  it('matches dynamic segments and passes params', () => {
    const seen: GioSocket[] = [];
    const { dispatcher } = harness({ '/chat/:room': socket => void seen.push(socket) });
    dispatcher.handle(connectFrame('c1', '/chat/lobby'));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.params).toEqual({ room: 'lobby' });
    expect(seen[0]?.path).toBe('/chat/lobby');
  });

  it('prefers the most specific pattern, like pages do', () => {
    const hits: string[] = [];
    const { dispatcher } = harness({
      '/chat/:room': () => void hits.push('param'),
      '/chat/admin': () => void hits.push('static'),
      '/chat/*rest': () => void hits.push('catch-all'),
    });
    dispatcher.handle(connectFrame('c1', '/chat/admin'));
    dispatcher.handle(connectFrame('c2', '/chat/lobby'));
    dispatcher.handle(connectFrame('c3', '/chat/a/b'));
    expect(hits).toEqual(['static', 'param', 'catch-all']);
  });

  it('passes catch-all params with their slashes', () => {
    let params: Record<string, string> = {};
    const { dispatcher } = harness({ '/live/*topic': socket => void (params = socket.params) });
    dispatcher.handle(connectFrame('c1', '/live/news/eu'));
    expect(params).toEqual({ topic: 'news/eu' });
  });

  it('closes a connection no wsHandler matches with 4404', () => {
    const { dispatcher, writes } = harness({ '/chat/:room': () => {} });
    dispatcher.handle(connectFrame('c1', '/elsewhere'));
    expect(writes).toEqual([
      { type: 'ws_close', connId: 'c1', code: WS_NO_HANDLER_CODE, reason: 'no websocket handler' },
    ]);
  });

  it('closes a connection to a route.ts that failed to import with 1011, not 4404, and logs it under a digest', () => {
    const wsHandlers = new Map<string, WsHandlerFn>();
    const handlers = new Map<string, HandlerEntry>();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      registerFailedRouteModule(new Error('REQ_VAR is not set'), '/app/chat/[room]/route.ts', '/chat/:room', wsHandlers, handlers);
      // A broader wsHandler does not take the failed route's URLs over.
      wsHandlers.set('/chat/*rest', () => {});
      const writes: WsOutbound[] = [];
      const dispatcher = createWsDispatcher(wsHandlers, msg => writes.push(msg));
      dispatcher.handle(connectFrame('c1', '/chat/lobby'));
      expect(writes).toHaveLength(1);
      const close = writes[0] as { type: string; code: number; reason: string };
      expect(close.type).toBe('ws_close');
      expect(close.code).toBe(1011);
      const digest = /^internal error \(digest ([0-9a-f]{12})\)$/.exec(close.reason)?.[1];
      expect(digest).toBeDefined();
      expect(close.reason).not.toContain('REQ_VAR');
      const perConnection = errorSpy.mock.calls.at(-1);
      expect(perConnection?.[0]).toBe('route file failed to load');
      expect(perConnection?.[1]).toMatchObject({
        path: '/chat/lobby',
        connId: 'c1',
        digest,
        filePath: '/app/chat/[room]/route.ts',
        error: 'REQ_VAR is not set',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('falls back to routeId when an older server sends no path', () => {
    const seen: GioSocket[] = [];
    const { dispatcher } = harness({ '/chat/:room': socket => void seen.push(socket) });
    dispatcher.handle({ type: 'ws_connect', connId: 'c1', routeId: '/chat/x', addr: 'a' });
    expect(seen[0]?.params).toEqual({ room: 'x' });
    expect(seen[0]?.headers).toEqual({});
    expect(seen[0]?.cookies).toEqual({});
  });
});

describe('ws connection context', () => {
  it('exposes query, headers, parsed cookies, ip and requestId', () => {
    let socket: GioSocket | undefined;
    const { dispatcher } = harness({ '/chat/:room': s => void (socket = s) });
    dispatcher.handle(
      connectFrame('c1', '/chat/lobby', {
        query: { token: 'abc' },
        headers: { cookie: 'gio_session=tok; theme=dark', 'user-agent': 'UA' },
        ip: '203.0.113.9',
        requestId: 'req-7',
      }),
    );
    expect(socket?.query).toEqual({ token: 'abc' });
    expect(socket?.headers['user-agent']).toBe('UA');
    expect(socket?.cookies).toEqual({ gio_session: 'tok', theme: 'dark' });
    expect(socket?.ip).toBe('203.0.113.9');
    expect(socket?.requestId).toBe('req-7');
  });
});

describe('ws accept/reject contract', () => {
  it('returning false closes with 4401 and never delivers messages', () => {
    const onMessage = vi.fn();
    const { dispatcher, writes } = harness({
      '/ws': socket => {
        socket.on('message', onMessage);
        return false;
      },
    });
    dispatcher.handle(connectFrame('c1', '/ws'));
    dispatcher.handle({ type: 'ws_message', connId: 'c1', data: 'hi', isBinary: false });
    expect(writes).toEqual([
      { type: 'ws_close', connId: 'c1', code: WS_REJECTED_CODE, reason: 'unauthorized' },
    ]);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('an async handler holds messages until it accepts, then delivers them in order', async () => {
    const received: Array<string | Buffer> = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => (release = resolve));
    const { dispatcher } = harness({
      '/ws': async socket => {
        await gate; // e.g. a session lookup
        socket.on('message', data => received.push(data));
      },
    });
    dispatcher.handle(connectFrame('c1', '/ws'));
    dispatcher.handle({ type: 'ws_message', connId: 'c1', data: 'one', isBinary: false });
    dispatcher.handle({ type: 'ws_message', connId: 'c1', data: 'two', isBinary: false });
    await settle();
    expect(received).toEqual([]);
    release();
    await settle();
    expect(received).toEqual(['one', 'two']);
    dispatcher.handle({ type: 'ws_message', connId: 'c1', data: 'three', isBinary: false });
    expect(received).toEqual(['one', 'two', 'three']);
  });

  it('an async handler resolving false rejects and drops what it held', async () => {
    const onMessage = vi.fn();
    const lookup = async (): Promise<string | undefined> => undefined; // finds nobody
    const { dispatcher, writes } = harness({
      '/ws': async socket => {
        const userId = await lookup();
        if (userId === undefined) return false;
        socket.on('message', onMessage);
        return true;
      },
    });
    dispatcher.handle(connectFrame('c1', '/ws'));
    dispatcher.handle(messageFrame('c1', 'early'));
    await settle();
    expect(writes).toEqual([
      { type: 'ws_close', connId: 'c1', code: WS_REJECTED_CODE, reason: 'unauthorized' },
    ]);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('an async handler can await its first message (token auth)', async () => {
    // Browsers cannot set headers on a WebSocket, so the first message often
    // carries the credential. The handler waits on it inside its own promise:
    // holding messages until that promise settles would deadlock.
    const after: string[] = [];
    const { dispatcher, writes } = harness({
      '/live': async socket => {
        const token = await new Promise<string>(resolve =>
          socket.on('message', data => resolve(String(data))),
        );
        if (token !== 'good') return false;
        socket.send('welcome');
        socket.on('message', data => after.push(String(data)));
        return true;
      },
    });
    dispatcher.handle(connectFrame('c1', '/live'));
    dispatcher.handle(messageFrame('c1', 'good'));
    await settle();
    expect(writes).toEqual([
      { type: 'ws_send', connId: 'c1', data: 'welcome', isBinary: false },
      ACCEPT('c1'),
    ]);
    dispatcher.handle(messageFrame('c1', 'hello'));
    expect(after).toEqual(['hello']);

    dispatcher.handle(connectFrame('c2', '/live'));
    dispatcher.handle(messageFrame('c2', 'forged'));
    await settle();
    expect(writes.at(-1)).toEqual({
      type: 'ws_close',
      connId: 'c2',
      code: WS_REJECTED_CODE,
      reason: 'unauthorized',
    });
  });

  it('messages held before the first listener reach it in order, while the handler still decides', async () => {
    const received: Array<string | Buffer> = [];
    let listen: () => void = () => {};
    let decide: () => void = () => {};
    const listening = new Promise<void>(resolve => (listen = resolve));
    const decided = new Promise<void>(resolve => (decide = resolve));
    const { dispatcher, writes } = harness({
      '/ws': async socket => {
        await listening;
        socket.on('message', data => received.push(data));
        await decided;
      },
    });
    dispatcher.handle(connectFrame('c1', '/ws'));
    dispatcher.handle(messageFrame('c1', 'one'));
    dispatcher.handle(messageFrame('c1', 'two'));
    await settle();
    expect(received).toEqual([]);
    listen();
    await settle();
    expect(received).toEqual(['one', 'two']);
    dispatcher.handle(messageFrame('c1', 'three'));
    expect(received).toEqual(['one', 'two', 'three']);
    expect(writes).toEqual([]); // still deciding: not accepted yet
    decide();
    await settle();
    expect(writes).toEqual([ACCEPT('c1')]);
  });

  it('socket.close() with a custom code rejects too', () => {
    const { dispatcher, writes } = harness({
      '/ws': socket => socket.close(4403, 'forbidden'),
    });
    dispatcher.handle(connectFrame('c1', '/ws'));
    expect(writes).toEqual([{ type: 'ws_close', connId: 'c1', code: 4403, reason: 'forbidden' }]);
  });

  it('a throwing or rejecting handler closes with 1011', async () => {
    const { dispatcher, writes } = harness({
      '/sync': () => {
        throw new Error('bug');
      },
      '/async': async () => {
        throw new Error('bug');
      },
    });
    dispatcher.handle(connectFrame('c1', '/sync'));
    dispatcher.handle(connectFrame('c2', '/async'));
    await settle();
    expect(writes).toEqual([
      { type: 'ws_close', connId: 'c1', code: 1011, reason: 'internal error' },
      { type: 'ws_close', connId: 'c2', code: 1011, reason: 'internal error' },
    ]);
  });

  it('a flood before an async handler accepts closes the connection with 1008', () => {
    const { dispatcher, writes } = harness({ '/ws': () => new Promise<void>(() => {}) });
    dispatcher.handle(connectFrame('c1', '/ws'));
    for (let i = 0; i <= MAX_HELD_MESSAGES; i++) {
      dispatcher.handle({ type: 'ws_message', connId: 'c1', data: String(i), isBinary: false });
    }
    expect(writes.at(-1)).toMatchObject({ type: 'ws_close', connId: 'c1', code: 1008 });
  });

  it('held messages are bounded by bytes per socket, not only by count', () => {
    const { dispatcher, writes } = harness({ '/ws': () => new Promise<void>(() => {}) });
    dispatcher.handle(connectFrame('c1', '/ws'));
    dispatcher.handle(messageFrame('c1', 'x'.repeat(MAX_HELD_BYTES)));
    expect(writes).toEqual([]);
    dispatcher.handle(messageFrame('c1', 'x'));
    expect(writes).toEqual([
      {
        type: 'ws_close',
        connId: 'c1',
        code: 1008,
        reason: 'too many messages before the connection was accepted',
      },
    ]);

    dispatcher.handle(connectFrame('c2', '/ws'));
    dispatcher.handle({
      type: 'ws_message',
      connId: 'c2',
      data: encodeBinaryPayload(Buffer.alloc(MAX_HELD_BYTES + 1)),
      isBinary: true,
    });
    expect(writes.at(-1)).toMatchObject({ type: 'ws_close', connId: 'c2', code: 1008 });
  });

  it('held messages are bounded across all sockets, and a closed socket frees its share', () => {
    const { dispatcher, writes } = harness({ '/ws': () => new Promise<void>(() => {}) });
    const full = 'x'.repeat(MAX_HELD_BYTES);
    const sockets = MAX_HELD_BYTES_TOTAL / MAX_HELD_BYTES;
    for (let i = 0; i < sockets; i++) {
      dispatcher.handle(connectFrame(`c${i}`, '/ws'));
      dispatcher.handle(messageFrame(`c${i}`, full));
    }
    expect(writes).toEqual([]);
    dispatcher.handle(connectFrame('over', '/ws'));
    dispatcher.handle(messageFrame('over', 'x'));
    expect(writes).toEqual([
      expect.objectContaining({ type: 'ws_close', connId: 'over', code: 1008 }),
    ]);

    dispatcher.handle({ type: 'ws_disconnect', connId: 'c0', code: 1001, reason: '' });
    dispatcher.handle(connectFrame('next', '/ws'));
    dispatcher.handle(messageFrame('next', full));
    expect(writes).toHaveLength(1);
  });

  it('a handler that neither listens nor settles stops holding after HOLD_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    try {
      const received: string[] = [];
      let listen: () => void = () => {};
      const listening = new Promise<void>(resolve => (listen = resolve));
      const { dispatcher, writes } = harness({
        // e.g. a feed loop that runs for the connection's lifetime
        '/ws': async socket => {
          await listening;
          socket.on('message', data => received.push(String(data)));
          await new Promise<void>(() => {});
        },
      });
      dispatcher.handle(connectFrame('c1', '/ws'));
      dispatcher.handle(messageFrame('c1', 'early'));
      await vi.advanceTimersByTimeAsync(HOLD_TIMEOUT_MS);
      // Dropped, not held forever: a client of such a handler is not closed
      // for sending more than the hold allows.
      for (let i = 0; i <= MAX_HELD_MESSAGES; i++) dispatcher.handle(messageFrame('c1', String(i)));
      expect(writes).toEqual([]);
      listen();
      await vi.advanceTimersByTimeAsync(0);
      dispatcher.handle(messageFrame('c1', 'late'));
      expect(received).toEqual(['late']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepting sends ws_accept once; rejecting, closing or no handler never does', async () => {
    let accepted: GioSocket | undefined;
    const { dispatcher, writes } = harness({
      '/sync': s => void (accepted = s),
      '/async': async () => true,
      '/deny': () => false,
      '/close': s => s.close(4403, 'forbidden'),
    });
    dispatcher.handle(connectFrame('c1', '/sync'));
    dispatcher.handle(connectFrame('c2', '/async'));
    dispatcher.handle(connectFrame('c3', '/deny'));
    dispatcher.handle(connectFrame('c4', '/close'));
    dispatcher.handle(connectFrame('c5', '/nowhere'));
    await settle();
    accepted?.close();
    expect(writes.filter(w => w.type === 'ws_accept')).toEqual([ACCEPT('c1'), ACCEPT('c2')]);
  });

  it('nothing is sent after close', () => {
    let socket: GioSocket | undefined;
    const { dispatcher, writes } = harness({ '/ws': s => void (socket = s) });
    dispatcher.handle(connectFrame('c1', '/ws'));
    socket?.close();
    socket?.send('late');
    socket?.close();
    expect(writes).toEqual([ACCEPT('c1'), { type: 'ws_close', connId: 'c1', code: 1000, reason: '' }]);
  });
});

describe('ws rooms', () => {
  it('join and leave send control frames once per change', () => {
    let socket: GioSocket | undefined;
    const { dispatcher, writes } = harness({ '/ws': s => void (socket = s) });
    dispatcher.handle(connectFrame('c1', '/ws'));
    socket?.join('lobby');
    socket?.join('lobby');
    expect([...(socket?.rooms ?? [])]).toEqual(['lobby']);
    socket?.leave('lobby');
    socket?.leave('lobby');
    expect(writes).toEqual([
      ACCEPT('c1'),
      { type: 'ws_join', connId: 'c1', room: 'lobby' },
      { type: 'ws_leave', connId: 'c1', room: 'lobby' },
    ]);
    expect(socket?.rooms.size).toBe(0);
  });

  it('bounds room names and memberships per socket', () => {
    const socket = new GioSocketImpl('c1', '/ws', () => {});
    expect(() => socket.join('')).toThrow(TypeError);
    expect(() => socket.join('x'.repeat(MAX_ROOM_NAME_BYTES + 1))).toThrow(RangeError);
    for (let i = 0; i < MAX_ROOMS_PER_SOCKET; i++) socket.join(`room-${i}`);
    expect(() => socket.join('one-too-many')).toThrow(RangeError);
    socket.join('room-0'); // already a member: not a new membership
  });

  it('memberships end with the connection', () => {
    let socket: GioSocket | undefined;
    const { dispatcher } = harness({ '/ws': s => void (socket = s) });
    dispatcher.handle(connectFrame('c1', '/ws'));
    socket?.join('a');
    dispatcher.handle({ type: 'ws_disconnect', connId: 'c1', code: 1001, reason: '' });
    expect(socket?.rooms.size).toBe(0);
    expect(dispatcher.size).toBe(0);
  });

  it('broadcast(room) frames text and binary payloads and honors except', () => {
    const writes: WsOutbound[] = [];
    const hub = wsHub();
    const previous = hub.write;
    hub.write = msg => writes.push(msg);
    try {
      expect(broadcast('lobby', 'hello')).toBe(true);
      expect(broadcast('lobby', new Uint8Array([0xff, 0x00]), { except: 'c1' })).toBe(true);
      expect(() => broadcast('', 'x')).toThrow(TypeError);
    } finally {
      hub.write = previous;
    }
    expect(writes).toEqual([
      { type: 'ws_room_broadcast', room: 'lobby', data: 'hello', isBinary: false },
      { type: 'ws_room_broadcast', room: 'lobby', data: '/wA=', isBinary: true, except: 'c1' },
    ]);
  });

  it('broadcast(room) reports false while no WebSocket server is connected', () => {
    const hub = wsHub();
    const previous = hub.write;
    hub.write = null;
    try {
      expect(broadcast('lobby', 'hello')).toBe(false);
    } finally {
      hub.write = previous;
    }
  });

  it('room broadcasts are droppable payload frames; join/leave never are', () => {
    expect(isDroppableWsFrame({ type: 'ws_room_broadcast', room: 'r', data: '', isBinary: false })).toBe(true);
    expect(isDroppableWsFrame({ type: 'ws_join', connId: 'c', room: 'r' })).toBe(false);
    expect(isDroppableWsFrame({ type: 'ws_leave', connId: 'c', room: 'r' })).toBe(false);
  });
});

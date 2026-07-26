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
  MAX_WS_IPC_FRAME_BYTES,
  createWsIpcServer,
  decodeBinaryPayload,
  encodeBinaryPayload,
  makeWsFrameHandler,
  validateWsInbound,
  wsAuthIsValid,
} from './ws-ipc.ts';
import { handshakeProof } from './ipc.ts';

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
      const outboundPromise = new Promise<WsOutbound>(resolve => {
        client.on('data', (chunk: Buffer) => {
          clientBuf = Buffer.concat([clientBuf, chunk]);
          if (clientBuf.length < 4) return;
          const len = clientBuf.readUInt32BE(0);
          if (clientBuf.length < 4 + len) return;
          resolve(JSON.parse(clientBuf.subarray(4, 4 + len).toString('utf8')) as WsOutbound);
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
      expect(outbound).toEqual({
        type: 'ws_send',
        connId: 'c1',
        data: Buffer.from([0x01, 0xff]).toString('base64'),
        isBinary: true,
      });

      client.destroy();
    } finally {
      server.close();
      delete process.env['GIO_WS_SOCKET_PATH'];
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

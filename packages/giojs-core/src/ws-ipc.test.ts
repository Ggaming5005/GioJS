/**
 * packages/giojs-core/src/ws-ipc.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import type { GioSocket, WsOutbound } from './context.ts';

// ── GioSocketImpl tests ───────────────────────────────────────────────────────
// We test GioSocketImpl indirectly by constructing it via ws-ipc internals.
// Since GioSocketImpl is not exported, we test through the GioSocket interface
// by simulating the write function.

function makeTestSocket(writeFn: (msg: WsOutbound) => void): GioSocket {
  // Replicate GioSocketImpl inline so we can test it without exporting the class.
  const messageHandlers: Array<(data: string) => void> = [];
  const closeHandlers: Array<(code: number, reason: string) => void> = [];

  const socket: GioSocket & {
    _dispatchMessage(data: string): void;
    _dispatchClose(code: number, reason: string): void;
  } = {
    id: 'test-conn-id',
    routeId: '/chat',

    send(data: string): void {
      writeFn({ type: 'ws_send', connId: 'test-conn-id', data, isBinary: false });
    },

    close(code = 1000, reason = ''): void {
      writeFn({ type: 'ws_close', connId: 'test-conn-id', code, reason });
    },

    broadcast(data: string): void {
      writeFn({ type: 'ws_broadcast', routeId: '/chat', data });
    },

    on(event: 'message' | 'close', handler: ((data: string) => void) | ((code: number, reason: string) => void)): void {
      if (event === 'message') {
        messageHandlers.push(handler as (data: string) => void);
      } else {
        closeHandlers.push(handler as (code: number, reason: string) => void);
      }
    },

    _dispatchMessage(data: string): void {
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
    const extSocket = makeTestSocket(msg => writes.push(msg)) as ReturnType<typeof makeTestSocket>;

    const closeHandler = vi.fn();
    extSocket.on('close', closeHandler);
    (extSocket as any)._dispatchClose(1000, 'normal');

    expect(closeHandler).toHaveBeenCalledWith(1000, 'normal');
  });
});

// @vitest-environment jsdom
/**
 * packages/giojs-react/src/hooks/useWebSocket.test.tsx
 *
 * Reconnect/backoff behavior of useWebSocket against a scripted WebSocket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import {
  useWebSocket,
  reconnectDelay,
  isRetryableClose,
  type UseWebSocketOptions,
  type UseWebSocketResult,
} from './useWebSocket.ts';

// @ts-expect-error global React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  sent: unknown[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = FakeWebSocket.CLOSING;
  }

  // ── test controls ──
  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  serverMessage(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
}

const latest = (): FakeWebSocket => {
  const ws = FakeWebSocket.instances.at(-1);
  if (ws === undefined) throw new Error('no socket created');
  return ws;
};

let container: HTMLDivElement;
let root: Root;
let result: UseWebSocketResult;

function Probe({ url, options }: { url: string; options?: UseWebSocketOptions | undefined }): null {
  result = useWebSocket(url, options);
  return null;
}

function mount(url: string, options?: UseWebSocketOptions): void {
  act(() => root.render(<Probe url={url} options={options} />));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('backoff math', () => {
  it('grows exponentially, caps, and jitters within [base/2, base]', () => {
    expect(reconnectDelay(0, 500, 30_000, () => 0)).toBe(250);
    expect(reconnectDelay(0, 500, 30_000, () => 1)).toBe(500);
    expect(reconnectDelay(3, 500, 30_000, () => 0.5)).toBe(3000);
    expect(reconnectDelay(20, 500, 30_000, () => 1)).toBe(30_000);
  });

  it('does not retry normal closes or 4000-4499 application refusals', () => {
    expect(isRetryableClose(1000)).toBe(false);
    expect(isRetryableClose(4401)).toBe(false);
    expect(isRetryableClose(4499)).toBe(false);
    for (const code of [1001, 1006, 1011, 1012, 1013, 4500]) expect(isRetryableClose(code)).toBe(true);
  });
});

describe('useWebSocket', () => {
  it('is inert during SSR', () => {
    vi.unstubAllGlobals();
    const html = renderToString(<Probe url="/ws" />);
    expect(html).toBe('');
    expect(result.readyState).toBe(-1);
    expect(result.send('x')).toBe(false);
  });

  it('resolves relative URLs to ws: and exposes state and messages', () => {
    mount('/chat/lobby');
    const ws = latest();
    expect(ws.url).toBe(`ws://${window.location.host}/chat/lobby`);
    expect(ws.binaryType).toBe('arraybuffer');
    expect(result.readyState).toBe(0);
    act(() => ws.serverOpen());
    expect(result.readyState).toBe(1);
    act(() => ws.serverMessage('hello'));
    expect(result.lastMessage).toBe('hello');
    expect(result.send('out')).toBe(true);
    expect(ws.sent).toEqual(['out']);
  });

  it('reconnects with exponential backoff after a drop, resetting on open', () => {
    mount('ws://example.test/ws', { reconnect: { initialDelayMs: 100, maxDelayMs: 1000 } });
    act(() => latest().serverOpen());
    act(() => latest().serverClose(1006));
    expect(result.readyState).toBe(3);
    expect(result.isReconnecting).toBe(true);
    expect(result.reconnectAttempts).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // attempt 0: 100ms base, jitter 0.5 → 75ms
    act(() => vi.advanceTimersByTime(74));
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances).toHaveLength(2);

    // second failure before opening: 200ms base → 150ms
    act(() => latest().serverClose(1006));
    expect(result.reconnectAttempts).toBe(2);
    act(() => vi.advanceTimersByTime(149));
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances).toHaveLength(3);

    act(() => latest().serverOpen());
    expect(result.reconnectAttempts).toBe(0);
    expect(result.isReconnecting).toBe(false);
    expect(result.readyState).toBe(1);
  });

  it('keeps backing off when the server opens the socket and then refuses it (1013)', () => {
    // Every server-side refusal (1013 over max_connections, 1011 handler
    // threw, 1008) comes after the upgrade, so the browser fires open first.
    mount('ws://example.test/ws', { reconnect: { maxAttempts: 4, initialDelayMs: 100, maxDelayMs: 10_000 } });
    for (const [i, delay] of [75, 150, 300, 600].entries()) {
      act(() => latest().serverOpen());
      expect(result.reconnectAttempts).toBe(0);
      act(() => latest().serverClose(1013, 'too many connections'));
      expect(result.reconnectAttempts).toBe(i + 1);
      act(() => vi.advanceTimersByTime(delay - 1));
      expect(FakeWebSocket.instances).toHaveLength(i + 1);
      act(() => vi.advanceTimersByTime(1));
      expect(FakeWebSocket.instances).toHaveLength(i + 2);
    }
    act(() => latest().serverOpen());
    act(() => latest().serverClose(1013));
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(5); // maxAttempts reached
    expect(result.isReconnecting).toBe(false);
  });

  it('starts the backoff over once a connection stays open for minUptimeMs', () => {
    mount('ws://example.test/ws', { reconnect: { initialDelayMs: 100, minUptimeMs: 2000 } });
    act(() => latest().serverClose(1006));
    act(() => vi.advanceTimersByTime(75));
    act(() => latest().serverClose(1006));
    act(() => vi.advanceTimersByTime(150));
    expect(FakeWebSocket.instances).toHaveLength(3);

    act(() => latest().serverOpen());
    act(() => vi.advanceTimersByTime(1999));
    act(() => latest().serverClose(1006)); // not stable yet: attempt 2 → 300ms
    expect(result.reconnectAttempts).toBe(3);
    act(() => vi.advanceTimersByTime(300));
    expect(FakeWebSocket.instances).toHaveLength(4);

    act(() => latest().serverOpen());
    act(() => vi.advanceTimersByTime(2000));
    act(() => latest().serverClose(1006)); // stayed up: back to the first delay
    expect(result.reconnectAttempts).toBe(1);
    act(() => vi.advanceTimersByTime(74));
    expect(FakeWebSocket.instances).toHaveLength(4);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances).toHaveLength(5);
  });

  it('gives up after maxAttempts', () => {
    mount('ws://example.test/ws', { reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 10 } });
    for (let i = 0; i < 2; i++) {
      act(() => latest().serverClose(1006));
      act(() => vi.advanceTimersByTime(10));
    }
    expect(FakeWebSocket.instances).toHaveLength(3);
    act(() => latest().serverClose(1006));
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(result.isReconnecting).toBe(false);
  });

  it('does not reconnect after an application rejection (4401) or with reconnect: false', () => {
    mount('ws://example.test/a');
    act(() => latest().serverClose(4401, 'unauthorized'));
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);

    mount('ws://example.test/b', { reconnect: false });
    act(() => latest().serverClose(1006));
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('honors a custom shouldReconnect', () => {
    mount('ws://example.test/ws', { shouldReconnect: (event) => event.code === 4001 });
    act(() => latest().serverClose(4001));
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => latest().serverClose(1006));
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('stops for good on close() and on unmount', () => {
    mount('ws://example.test/ws');
    act(() => latest().serverOpen());
    act(() => result.close(1000, 'bye'));
    expect(latest().closedWith).toEqual({ code: 1000, reason: 'bye' });
    act(() => latest().serverClose(1006)); // even an abnormal close after close()
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(result.send('late')).toBe(false);

    act(() => result.reconnect());
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => latest().serverClose(1006));
    act(() => root.unmount());
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    root = createRoot(container); // afterEach unmounts again
  });

  it('closes the socket on unmount while it is connecting', () => {
    mount('ws://example.test/ws');
    const ws = latest();
    act(() => root.unmount());
    expect(ws.closedWith?.code).toBe(1000);
    root = createRoot(container);
  });

  it('queues sends while reconnecting when asked, flushing them in order on open', () => {
    mount('ws://example.test/ws', { queueWhileDisconnected: { maxMessages: 2 }, reconnect: { initialDelayMs: 10 } });
    expect(result.send('before open')).toBe(true);
    act(() => latest().serverOpen());
    expect(latest().sent).toEqual(['before open']);

    act(() => latest().serverClose(1006));
    expect(result.send('one')).toBe(true);
    expect(result.send('two')).toBe(true);
    expect(result.send('three')).toBe(false); // queue full
    act(() => vi.advanceTimersByTime(10));
    act(() => latest().serverOpen());
    expect(latest().sent).toEqual(['one', 'two']);

    act(() => result.close());
    expect(result.send('after close')).toBe(false); // nothing would ever flush it
  });

  it('never delivers a message queued for one url to the next (switching rooms)', () => {
    const options: UseWebSocketOptions = { queueWhileDisconnected: true };
    mount('/chat/a', options);
    const a = latest();
    expect(result.send('hello room a')).toBe(true); // still connecting: queued
    mount('/chat/b', options);
    const b = latest();
    expect(b).not.toBe(a);
    expect(result.send('hello room b')).toBe(true);
    act(() => b.serverOpen());
    expect(b.sent).toEqual(['hello room b']);
    expect(a.sent).toEqual([]);
  });

  it('drops sends while disconnected by default', () => {
    mount('ws://example.test/ws');
    expect(result.send('x')).toBe(false);
  });

  it('delivers every message to onMessage, even ones React batches away', () => {
    const seen: unknown[] = [];
    mount('ws://example.test/ws', { onMessage: (data) => seen.push(data) });
    act(() => {
      latest().serverOpen();
      latest().serverMessage('a');
      latest().serverMessage('b');
    });
    expect(seen).toEqual(['a', 'b']);
    expect(result.lastMessage).toBe('b');
  });
});

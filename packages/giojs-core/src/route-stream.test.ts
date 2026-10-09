/**
 * giojs-core/src/route-stream.test.ts
 *
 * Streaming route.ts Response bodies: when renderRoute buffers a Response
 * and when it streams it, and how pumpRouteStream turns the body into chunk
 * frames (binary safety, chunk splitting, flow control, cancellation).
 */
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { describe, it, expect, vi } from 'vitest';
import {
  renderRoute,
  ROUTE_BUFFER_LIMIT_BYTES,
  type RouteStreamResult,
} from './ssr.ts';
import {
  pumpRouteStream,
  routeChunkFrame,
  ROUTE_CHUNK_BYTES,
  MAX_BUFFERED_FRAME_BYTES,
  StreamFlowGate,
} from './ipc.ts';
import { NodePluginRegistry } from './plugin.ts';
import type { ChunkMsg, IPCRequest, IPCResponse } from './context.ts';
import type { HandlerEntry, LayoutEntry, RouteHandlerFn } from './router.ts';

const noLayouts = new Map<string, LayoutEntry>();

function makeRequest(path: string, method = 'GET'): IPCRequest {
  return {
    id: 'req-1',
    method,
    path,
    params: {},
    query: {},
    headers: {},
    body: null,
    bodyBase64: false,
    deploymentId: 'test-deploy',
    locale: 'en',
  };
}

function makeHandlers(pattern: string, methods: Record<string, RouteHandlerFn>): Map<string, HandlerEntry> {
  return new Map([
    [pattern, { filePath: '/fake/route.ts', urlPattern: pattern, methods: new Map(Object.entries(methods)) }],
  ]);
}

async function route(
  handler: RouteHandlerFn,
  { method = 'GET', streaming = true, registry }: { method?: string; streaming?: boolean; registry?: NodePluginRegistry } = {},
) {
  return renderRoute(
    makeRequest('/api/x', method),
    new Map(),
    noLayouts,
    registry,
    undefined,
    undefined,
    { handlers: makeHandlers('/api/x', { GET: handler, POST: handler }), streaming },
  );
}

function isRouteStream(value: unknown): value is RouteStreamResult {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'route-stream';
}

/** A ReadableStream the test feeds by hand, recording cancellation. */
function manualStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array | string>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array | string>({
    start(c) {
      controller = c;
    },
    cancel,
  });
  return { stream, controller, cancel };
}

class FakeSocket extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  private written: Buffer[] = [];

  write(data: Buffer): boolean {
    this.written.push(Buffer.from(data));
    return true;
  }

  frames(): Array<Record<string, unknown>> {
    let buf = Buffer.concat(this.written);
    const out: Array<Record<string, unknown>> = [];
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      out.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) as Record<string, unknown>);
      buf = buf.subarray(4 + len);
    }
    return out;
  }
}

function bodyOf(frames: Array<Record<string, unknown>>): Buffer {
  return Buffer.concat(
    frames
      .filter((f) => f['type'] === 'chunk')
      .map((f) => Buffer.from(String(f['data']), f['bodyBase64'] === true ? 'base64' : 'utf8')),
  );
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('route.ts Response: buffer or stream', () => {
  it('keeps complete small bodies buffered', async () => {
    const result = await route(() => new Response('hello', { headers: { 'x-a': '1' } }));
    expect(isRouteStream(result)).toBe(false);
    expect((result as IPCResponse).body).toBe('hello');
    expect((result as IPCResponse).streaming).toBeUndefined();
  });

  it('a proxied fetch() Response drops the encoding fetch already decoded; an app-encoded body keeps it', async () => {
    const text = 'proxied '.repeat(64);
    const gzipped = gzipSync(text);
    const upstream: Server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/javascript',
        'content-encoding': 'gzip',
        'content-length': String(gzipped.length),
        'x-upstream': '1',
      });
      res.end(gzipped);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/chunk.js`;
      for (const streaming of [false, true]) {
        const result = await route(() => fetch(url, { headers: { 'accept-encoding': 'gzip' } }), { streaming });
        let body: string;
        let head: IPCResponse;
        if (isRouteStream(result)) {
          // The body may still be arriving: streamed like any other.
          const socket = new FakeSocket();
          await pumpRouteStream(socket, 'req-1', result, new StreamFlowGate(), new AbortController().signal);
          body = Buffer.concat([...result.prelude, bodyOf(socket.frames())]).toString();
          head = result.head;
        } else {
          body = (result as IPCResponse).body;
          head = result as IPCResponse;
        }
        expect(body).toBe(text);
        expect(head.headers['content-encoding']).toBeUndefined();
        expect(head.headers['content-length']).toBeUndefined();
        expect(head.headers['x-upstream']).toBe('1');
      }
    } finally {
      await new Promise((resolve) => upstream.close(resolve));
    }

    // Bytes the app compressed itself are sent as they are, labeled.
    const precompressed = await route(
      () => new Response(gzipped, { headers: { 'content-encoding': 'gzip', 'content-type': 'text/plain' } }),
    );
    expect((precompressed as IPCResponse).headers['content-encoding']).toBe('gzip');
    expect((precompressed as IPCResponse).bodyBase64).toBe(true);
  });

  it('keeps a stream that finishes without waiting buffered', async () => {
    const result = await route(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('all at once'));
              c.close();
            },
          }),
        ),
    );
    expect((result as IPCResponse).body).toBe('all at once');
    expect((result as IPCResponse).routeHandler).toBe(true);
  });

  it('streams a body that is still being produced, cookies and headers on the head', async () => {
    const { stream, controller } = manualStream();
    controller.enqueue(new TextEncoder().encode('first '));
    const headers = new Headers({ 'content-type': 'text/plain', 'x-model': 'm1' });
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Path=/; HttpOnly');
    const result = await route(() => new Response(stream, { status: 201, headers }));
    expect(isRouteStream(result)).toBe(true);
    const streamed = result as RouteStreamResult;
    expect(streamed.head).toMatchObject({
      status: 201,
      body: '',
      streaming: true,
      routeStream: true,
      // Rust leaves a handler's Cache-Control to the app, streamed or not.
      routeHandler: true,
      cacheable: false,
      headers: { 'content-type': 'text/plain', 'x-model': 'm1' },
      setCookies: ['a=1; Path=/', 'b=2; Path=/; HttpOnly'],
    });
    expect(Buffer.concat(streamed.prelude).toString()).toBe('first ');

    const socket = new FakeSocket();
    const pumping = pumpRouteStream(socket, 'req-1', streamed, new StreamFlowGate(), new AbortController().signal);
    controller.enqueue('second');
    controller.close();
    await pumping;
    const frames = socket.frames();
    expect(bodyOf(frames).toString()).toBe('first second');
    expect(frames.at(-1)).toEqual({ type: 'chunk_end', id: 'req-1' });
  });

  it('always streams an event-stream body, even a complete one', async () => {
    const result = await route(
      () => new Response('data: hi\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    );
    expect(isRouteStream(result)).toBe(true);
    const streamed = result as RouteStreamResult;
    expect(streamed.rest).toBeNull();
    const socket = new FakeSocket();
    await pumpRouteStream(socket, 'req-1', streamed, new StreamFlowGate(), new AbortController().signal);
    expect(bodyOf(socket.frames()).toString()).toBe('data: hi\n\n');
    expect(socket.frames().at(-1)).toEqual({ type: 'chunk_end', id: 'req-1' });
  });

  it('streams an empty event stream too, so it ends instead of waiting for SSE frames', async () => {
    const result = await route(() => new Response(null, { headers: { 'content-type': 'text/event-stream' } }));
    expect(isRouteStream(result)).toBe(true);
    expect((result as RouteStreamResult).head.routeStream).toBe(true);
    const socket = new FakeSocket();
    await pumpRouteStream(socket, 'req-1', result as RouteStreamResult, new StreamFlowGate(), new AbortController().signal);
    expect(socket.frames()).toEqual([{ type: 'chunk_end', id: 'req-1' }]);
  });

  it('streams bodies over the read-ahead budget, split into bounded frames', async () => {
    const big = Buffer.alloc(ROUTE_BUFFER_LIMIT_BYTES * 2 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
    const result = await route(() => new Response(big, { headers: { 'content-type': 'application/octet-stream' } }));
    expect(isRouteStream(result)).toBe(true);
    const socket = new FakeSocket();
    await pumpRouteStream(socket, 'req-1', result as RouteStreamResult, new StreamFlowGate(), new AbortController().signal);
    const frames = socket.frames();
    expect(bodyOf(frames).equals(big)).toBe(true);
    for (const frame of frames.filter((f) => f['type'] === 'chunk')) {
      expect(Buffer.from(String(frame['data']), 'base64').length).toBeLessThanOrEqual(ROUTE_CHUNK_BYTES);
    }
  });

  it('HEAD stops a streaming body instead of sending it', async () => {
    const { stream, controller, cancel } = manualStream();
    controller.enqueue('never sent');
    const result = await route(() => new Response(stream), { method: 'HEAD' });
    expect(isRouteStream(result)).toBe(false);
    expect((result as IPCResponse).body).toBe('');
    await tick();
    expect(cancel).toHaveBeenCalled();
  });

  it('buffers non-event-stream bodies while onResponse plugins need them', async () => {
    const registry = new NodePluginRegistry();
    registry.register({
      name: 'seen',
      version: '0.0.0',
      onResponse: async (_req, res) => ({ ...res, headers: { ...res.headers, 'x-seen': '1' } }),
    });
    const slow = () =>
      new Response(
        new ReadableStream({
          async pull(c) {
            await tick();
            c.enqueue(new TextEncoder().encode('late'));
            c.close();
          },
        }),
      );
    const buffered = await route(slow, { registry });
    expect(isRouteStream(buffered)).toBe(false);
    expect((buffered as IPCResponse).body).toBe('late');
    expect((buffered as IPCResponse).headers['x-seen']).toBe('1');

    const { stream } = manualStream();
    const events = await route(
      () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      { registry },
    );
    expect(isRouteStream(events)).toBe(true);
  });

  it('never streams without the live IPC opt-in (static export)', async () => {
    const result = await route(
      () =>
        new Response(
          new ReadableStream({
            async pull(c) {
              await tick();
              c.enqueue(new TextEncoder().encode('late'));
              c.close();
            },
          }),
        ),
      { streaming: false },
    );
    expect((result as IPCResponse).body).toBe('late');
  });
});

describe('pumpRouteStream', () => {
  it('cancels the body reader when Rust cancels the request, without chunk_end', async () => {
    const { stream, controller, cancel } = manualStream();
    controller.enqueue('tick 1\n');
    const result = (await route(
      () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    )) as RouteStreamResult;
    const socket = new FakeSocket();
    const abort = new AbortController();
    const pumping = pumpRouteStream(socket, 'req-1', result, new StreamFlowGate(), abort.signal);
    await tick();
    abort.abort();
    await pumping;
    expect(cancel).toHaveBeenCalled();
    expect(socket.frames().some((f) => f['type'] === 'chunk_end')).toBe(false);
  });

  it('waits while Rust says pause and continues on resume, ignoring stale seq', async () => {
    const { stream, controller } = manualStream();
    controller.enqueue('a');
    const result = (await route(() => new Response(stream))) as RouteStreamResult;
    const socket = new FakeSocket();
    const gate = new StreamFlowGate();
    gate.apply(true, 2);
    gate.apply(false, 1); // overtaken resume from before the pause: ignored
    const pumping = pumpRouteStream(socket, 'req-1', result, gate, new AbortController().signal);
    await tick();
    expect(socket.frames()).toEqual([]);
    gate.apply(false, 3);
    controller.close();
    await pumping;
    expect(bodyOf(socket.frames()).toString()).toBe('a');
  });

  it('waits for the IPC socket to drain past the buffered-bytes cap', async () => {
    const { stream, controller } = manualStream();
    controller.enqueue('x');
    controller.close();
    const result = (await route(
      () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    )) as RouteStreamResult;
    const socket = new FakeSocket();
    socket.writableLength = MAX_BUFFERED_FRAME_BYTES + 1;
    const pumping = pumpRouteStream(socket, 'req-1', result, new StreamFlowGate(), new AbortController().signal);
    await tick();
    expect(socket.frames()).toEqual([]);
    socket.writableLength = 0;
    socket.emit('drain');
    await pumping;
    expect(bodyOf(socket.frames()).toString()).toBe('x');
    expect(socket.listenerCount('drain') + socket.listenerCount('close')).toBe(0);
  });

  it('ends the body with an aborted chunk_end when the stream errors', async () => {
    const { stream, controller } = manualStream();
    controller.enqueue('partial');
    const result = (await route(() => new Response(stream))) as RouteStreamResult;
    const socket = new FakeSocket();
    const pumping = pumpRouteStream(socket, 'req-1', result, new StreamFlowGate(), new AbortController().signal);
    controller.error(new Error('upstream died'));
    await pumping;
    const frames = socket.frames();
    expect(bodyOf(frames).toString()).toBe('partial');
    expect(frames.at(-1)).toEqual({ type: 'chunk_end', id: 'req-1', aborted: true });
  });
});

describe('routeChunkFrame', () => {
  it('sends UTF-8 as text and anything else as base64', () => {
    expect(routeChunkFrame('r', new TextEncoder().encode('héllo'))).toEqual({ type: 'chunk', id: 'r', data: 'héllo' });
    const binary: ChunkMsg = routeChunkFrame('r', new Uint8Array([0xff, 0x00]));
    expect(binary).toEqual({ type: 'chunk', id: 'r', data: '/wA=', bodyBase64: true });
  });
});

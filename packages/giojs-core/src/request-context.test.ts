/**
 * giojs-core/src/request-context.test.ts
 *
 * Request ids through the worker: logger lines carry the id of the request
 * being handled (and only that one, with requests interleaved on the single
 * worker), and the IPC server wires each request frame's `requestId` into
 * that context, its route handler, and its error frame.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger, withRequestLogContext } from './logger.ts';
import type { GioRequest } from './context.ts';
import type { HandlerEntry, LayoutEntry, RouteModule } from './router.ts';

/** Capture the logger's JSON lines (it writes to stderr). */
function captureLogs(): { lines: () => Record<string, unknown>[]; restore: () => void } {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  return {
    lines: () =>
      written
        .join('')
        .split('\n')
        .filter(line => line.startsWith('{'))
        .map(line => JSON.parse(line) as Record<string, unknown>),
    restore: () => spy.mockRestore(),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('withRequestLogContext', () => {
  let logs: ReturnType<typeof captureLogs> | undefined;
  afterEach(() => {
    logs?.restore();
    logs = undefined;
  });

  it('stamps the request id on lines logged inside, never outside', async () => {
    logs = captureLogs();
    logger.info('before');
    await withRequestLogContext({ requestId: 'rid-1' }, async () => {
      logger.info('inside');
      await new Promise(r => setTimeout(r, 1));
      logger.warn('after a timer', { extra: 1 });
    });
    logger.info('after');
    const byMsg = new Map(logs.lines().map(l => [l['msg'], l]));
    expect(byMsg.get('before')).not.toHaveProperty('requestId');
    expect(byMsg.get('inside')?.['requestId']).toBe('rid-1');
    expect(byMsg.get('after a timer')).toMatchObject({ requestId: 'rid-1', extra: 1 });
    expect(byMsg.get('after')).not.toHaveProperty('requestId');
  });

  it('keeps interleaved requests apart', async () => {
    logs = captureLogs();
    const gateA = deferred();
    const gateB = deferred();
    const run = (id: string, gate: Promise<void>): Promise<void> =>
      withRequestLogContext({ requestId: id }, async () => {
        logger.info('start', { who: id });
        await gate;
        logger.info('end', { who: id });
      });
    const a = run('rid-A', gateA.promise);
    const b = run('rid-B', gateB.promise);
    // B finishes first, then A: each resumes in its own context.
    gateB.resolve();
    await b;
    gateA.resolve();
    await a;
    const lines = logs.lines().filter(l => l['who'] !== undefined);
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line['requestId']).toBe(line['who']);
    }
  });

  it('runs without a context when there is no request id', () => {
    logs = captureLogs();
    expect(withRequestLogContext(undefined, () => 42)).toBe(42);
  });
});

// ─── through the IPC server ───────────────────────────────────────────────────

function frame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(json.byteLength, 0);
  return Buffer.concat([header, json]);
}

/** Collect length-prefixed JSON frames from a client socket. */
function frameReader(socket: net.Socket): (predicate: (f: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>> {
  const frames: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      frames.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) as Record<string, unknown>);
      buf = buf.subarray(4 + len);
    }
    for (const wake of waiters.splice(0)) wake();
  });
  return async predicate => {
    for (;;) {
      const found = frames.find(predicate);
      if (found !== undefined) return found;
      await new Promise<void>(resolve => waiters.push(resolve));
    }
  };
}

describe.skipIf(process.platform === 'win32')('IPC server request context', () => {
  it('carries each request id into handlers, log lines and error frames', async () => {
    const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'giojs-ipc-ctx-'));
    vi.stubEnv('GIO_SOCKET_PATH', nodePath.join(tmpDir, 'ipc.sock'));
    vi.stubEnv('GIO_IPC_TOKEN', '');
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    // PIPE_PATH is read at import time.
    const { createIPCServer } = await import('./ipc.ts');
    const { logger: workerLogger } = await import('./logger.ts');

    const gates = new Map([['rid-A', deferred()], ['rid-B', deferred()]]);
    const seen: GioRequest[] = [];
    const handlers = new Map<string, HandlerEntry>([
      ['/api/who', {
        filePath: '/fake/route.ts',
        urlPattern: '/api/who',
        methods: new Map([['GET', async (req: GioRequest) => {
          seen.push(req);
          workerLogger.info('handler start', { who: req.query['who'] });
          await gates.get(req.query['who'] ?? '')?.promise;
          workerLogger.info('handler end', { who: req.query['who'] });
          return { ip: req.ip ?? null, requestId: req.requestId ?? null };
        }]]),
      }],
    ]);
    const routes = new Map<string, RouteModule>([
      ['/boom', {
        filePath: '/fake/boom.tsx',
        urlPattern: '/boom',
        dir: 'boom',
        load: async () => ({
          default: () => React.createElement('p', null, 'unreachable'),
          getServerSideProps: async () => { throw new Error('FIXTURE_FAILURE'); },
        }),
      }],
    ]);

    const logs = captureLogs();
    const server = createIPCServer(routes, new Map<string, LayoutEntry>(), new Map(), undefined, undefined, { handlers });
    try {
      await once(server, 'listening');
      const client = net.connect(nodePath.join(tmpDir, 'ipc.sock'));
      await once(client, 'connect');
      const waitFrame = frameReader(client);
      await waitFrame(f => f['type'] === 'ready');
      client.write(frame({ type: 'ack', token: '' }));

      const request = (id: string, path: string, query: Record<string, string>, extra: object): void => {
        client.write(frame({
          id, method: 'GET', path, params: {}, query, headers: {}, body: null,
          deploymentId: 'd', locale: '', ...extra,
        }));
      };
      request('ipc-A', '/api/who', { who: 'rid-A' }, { requestId: 'rid-A', ip: '198.51.100.4', scheme: 'https' });
      request('ipc-B', '/api/who', { who: 'rid-B' }, { requestId: 'rid-B', ip: '2001:db8::1' });
      request('ipc-N', '/api/who', { who: 'none' }, {});
      // B completes before A: both stay in their own context.
      gates.get('rid-B')?.resolve();
      const b = await waitFrame(f => f['id'] === 'ipc-B');
      gates.get('rid-A')?.resolve();
      const a = await waitFrame(f => f['id'] === 'ipc-A');
      const none = await waitFrame(f => f['id'] === 'ipc-N');
      expect(JSON.parse(String(a['body']))).toEqual({ ip: '198.51.100.4', requestId: 'rid-A' });
      expect(JSON.parse(String(b['body']))).toEqual({ ip: '2001:db8::1', requestId: 'rid-B' });
      expect(JSON.parse(String(none['body']))).toEqual({ ip: null, requestId: null });
      expect(seen.find(r => r.requestId === 'rid-A')?.scheme).toBe('https');

      request('ipc-C', '/boom', {}, { requestId: 'rid-C' });
      const failed = await waitFrame(f => f['id'] === 'ipc-C');
      expect(failed).toMatchObject({ error: true, requestId: 'rid-C' });

      const handlerLines = logs.lines().filter(l => String(l['msg']).startsWith('handler '));
      expect(handlerLines).toHaveLength(6);
      for (const line of handlerLines) {
        if (line['who'] === 'none') {
          expect(line).not.toHaveProperty('requestId');
        } else {
          expect(line['requestId']).toBe(line['who']);
        }
      }
      // The operator's path: error reference (digest) -> log line -> request id.
      const failure = logs.lines().find(l => l['msg'] === 'ssr render failed');
      expect(failure).toMatchObject({ requestId: 'rid-C', digest: failed['digest'], error: 'FIXTURE_FAILURE' });
      client.destroy();
    } finally {
      logs.restore();
      server.close();
      vi.unstubAllEnvs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

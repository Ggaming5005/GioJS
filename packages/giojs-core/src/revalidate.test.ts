/**
 * giojs-core/src/revalidate.test.ts
 *
 * revalidateTag / revalidatePath: input validation, the frames sent to
 * Rust, ack / timeout / disconnect resolution, the no-server no-op, and the
 * tag sanitizing pages go through.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HandlerEntry, LayoutEntry, RouteModule } from './router.ts';
import {
  revalidateTag,
  revalidatePath,
  sanitizeCacheTags,
  enableRevalidation,
  attachRevalidationChannel,
  settleRevalidateAck,
  REVALIDATE_TIMEOUT_MS,
  MAX_REVALIDATIONS_IN_FLIGHT,
  type RevalidateFrame,
} from './revalidate.ts';

const BRIDGE_KEY = Symbol.for('gio.revalidate');

function resetBridge(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[BRIDGE_KEY];
}

/** A connected server that records frames and acks them on demand. */
function connect(): { frames: RevalidateFrame[]; detach: () => void } {
  enableRevalidation();
  const frames: RevalidateFrame[] = [];
  const detach = attachRevalidationChannel(frame => frames.push(frame));
  return { frames, detach };
}

/** Let the call reach its send() (it awaits nothing before, but be explicit). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  resetBridge();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetBridge();
});

describe('input validation', () => {
  it('rejects tags the server would refuse', async () => {
    const { frames } = connect();
    for (const tag of ['', 'x'.repeat(257), 'a\nb', '_gio:path:/x', 42 as unknown as string]) {
      await expect(revalidateTag(tag)).rejects.toThrow(TypeError);
    }
    expect(frames).toEqual([]);
  });

  it('rejects tags with an unpaired surrogate (their frame would not parse in Rust)', async () => {
    const { frames } = connect();
    const cut = `post:${'😀'.slice(0, 1)}`; // an emoji cut in half
    for (const tag of [cut, '\ud83d', '\ude00x', 'a\ude00\ud83d']) {
      await expect(revalidateTag(tag)).rejects.toThrow(/surrogate/);
    }
    expect(frames).toEqual([]);
    void revalidateTag('post:😀');
    await flush();
    expect(frames.map(f => f.tags)).toEqual([['post:😀']]);
  });

  it('rejects paths that are not URL paths, and unknown types', async () => {
    const { frames } = connect();
    for (const path of ['posts', '', 'http://x/y', '/a\u0000b', 7 as unknown as string]) {
      await expect(revalidatePath(path)).rejects.toThrow(TypeError);
    }
    await expect(
      revalidatePath('/x', { type: 'layout' as unknown as 'page' }),
    ).rejects.toThrow(/type must be/);
    expect(frames).toEqual([]);
  });

  it('rejects the paths the server refuses, instead of an ok:false from it', async () => {
    const { frames } = connect();
    for (const [path, reason] of [
      ['/a/../b', /segments/],
      ['/a/./b', /segments/],
      ['/a/%2e%2E/b', /segments/],
      ['/..', /segments/],
      ['/100%', /escape/],
      ['/%zz', /escape/],
      ['/a%2', /escape/],
      ['/_gio/health', /_gio/],
      ['//_gio', /_gio/],
      ['/%5Fgio/x', /_gio/],
      [`/caf${'é'.slice(0, 1)}\ud83d`, /surrogate/],
    ] as const) {
      await expect(revalidatePath(path), path).rejects.toThrow(reason);
      await expect(revalidatePath(path, { type: 'prefix' }), path).rejects.toThrow(TypeError);
    }
    expect(frames).toEqual([]);
  });

  it('sends decoded and encoded paths as given (the server encodes them the same way)', async () => {
    const { frames } = connect();
    const paths = ['/blog/café', '/blog/caf%C3%A9', '/blog/a b', '/100%25', '/a..b', '/.well-known/x', '/blog/_gio'];
    for (const path of paths) void revalidatePath(path);
    await flush();
    expect(frames.map(f => f.paths[0])).toEqual(paths);
  });
});

describe('frames and acks', () => {
  it('sends a tag frame and resolves with the purge count once acked', async () => {
    const { frames } = connect();
    const pending = revalidateTag('posts');
    await flush();
    expect(frames).toEqual([
      { type: 'revalidate', id: expect.any(String), tags: ['posts'], paths: [], prefix: false },
    ]);
    settleRevalidateAck({ type: 'revalidate_ack', id: frames[0]!.id, ok: true, purged: 3 });
    await expect(pending).resolves.toEqual({ ok: true, purged: 3 });
  });

  it('sends path frames without the query, with the prefix flag', async () => {
    const { frames } = connect();
    const page = revalidatePath('/blog/1?page=2#top');
    const prefix = revalidatePath('/blog', { type: 'prefix' });
    await flush();
    expect(frames.map(f => [f.paths, f.prefix])).toEqual([
      [['/blog/1'], false],
      [['/blog'], true],
    ]);
    expect(frames[0]!.id).not.toBe(frames[1]!.id);
    settleRevalidateAck({ type: 'revalidate_ack', id: frames[1]!.id, ok: true, purged: 5 });
    settleRevalidateAck({ type: 'revalidate_ack', id: frames[0]!.id, ok: true, purged: 1 });
    await expect(page).resolves.toEqual({ ok: true, purged: 1 });
    await expect(prefix).resolves.toEqual({ ok: true, purged: 5 });
  });

  it('resolves ok:false with the reason when the server refuses', async () => {
    const { frames } = connect();
    // Only the server knows the locales: /fr/_gio/x is /_gio/x there.
    const pending = revalidatePath('/fr/_gio/x');
    await flush();
    settleRevalidateAck({
      type: 'revalidate_ack',
      id: frames[0]!.id,
      ok: false,
      purged: 0,
      error: 'invalid path',
    });
    await expect(pending).resolves.toEqual({ ok: false, purged: 0, error: 'invalid path' });
  });

  it('ignores acks for unknown or malformed ids', () => {
    connect();
    expect(() => settleRevalidateAck({ type: 'revalidate_ack', id: 'rv-404', ok: true })).not.toThrow();
    expect(() => settleRevalidateAck({ type: 'revalidate_ack', ok: true })).not.toThrow();
  });

  it('times out gracefully instead of hanging or throwing', async () => {
    vi.useFakeTimers();
    const { frames } = connect();
    const pending = revalidateTag('posts');
    await flush();
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(REVALIDATE_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ ok: false, purged: 0, error: /timed out/ });
    // A late ack is ignored.
    settleRevalidateAck({ type: 'revalidate_ack', id: frames[0]!.id, ok: true, purged: 1 });
  });

  it('settles pending calls when the server connection closes', async () => {
    const { detach } = connect();
    const pending = revalidateTag('posts');
    await flush();
    detach();
    await expect(pending).resolves.toMatchObject({ ok: false, error: /connection closed/ });
  });

  it('waits for the server connection between connections', async () => {
    vi.useFakeTimers();
    enableRevalidation();
    const pending = revalidateTag('posts');
    await vi.advanceTimersByTimeAsync(100);
    const frames: RevalidateFrame[] = [];
    attachRevalidationChannel(frame => frames.push(frame));
    await flush();
    expect(frames).toHaveLength(1);
    settleRevalidateAck({ type: 'revalidate_ack', id: frames[0]!.id, ok: true, purged: 0 });
    await expect(pending).resolves.toEqual({ ok: true, purged: 0 });
  });

  it('gives up when no connection comes back in time', async () => {
    vi.useFakeTimers();
    enableRevalidation();
    const pending = revalidateTag('posts');
    await vi.advanceTimersByTimeAsync(REVALIDATE_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ ok: false, error: /no connection/ });
  });

  it('a stale detach does not drop a newer connection', async () => {
    enableRevalidation();
    const old = attachRevalidationChannel(() => undefined);
    const frames: RevalidateFrame[] = [];
    attachRevalidationChannel(frame => frames.push(frame));
    old();
    void revalidateTag('posts');
    await flush();
    expect(frames).toHaveLength(1);
  });

  it('a burst of calls waits its turn instead of overflowing the server queue', async () => {
    // Rust queues a worker's purges in 64 slots (REVALIDATE_QUEUE in
    // giojs-server/src/ipc.rs), refuses the overflow at once, and runs one
    // purge at a time - emulated here.
    const RUST_QUEUE = 64;
    enableRevalidation();
    const queued: RevalidateFrame[] = [];
    let mostQueued = 0;
    attachRevalidationChannel(frame => {
      if (queued.length >= RUST_QUEUE) {
        setImmediate(() => settleRevalidateAck({
          type: 'revalidate_ack', id: frame.id, ok: false, purged: 0,
          error: 'too many revalidations queued',
        }));
        return;
      }
      queued.push(frame);
      mostQueued = Math.max(mostQueued, queued.length);
    });
    let done = false;
    const executor = (async () => {
      while (!done) {
        const next = queued.shift();
        if (next !== undefined) {
          settleRevalidateAck({ type: 'revalidate_ack', id: next.id, ok: true, purged: 1 });
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    })();

    // revalidateTag takes one tag: purging a batch is N parallel calls.
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => revalidateTag(`post:${i}`)),
    );
    done = true;
    await executor;
    expect(results.filter(result => !result.ok)).toEqual([]);
    expect(mostQueued).toBeLessThanOrEqual(MAX_REVALIDATIONS_IN_FLIGHT);
  });

  it('calls waiting for their turn time out without sending', async () => {
    vi.useFakeTimers();
    const { frames } = connect();
    const calls = Array.from(
      { length: MAX_REVALIDATIONS_IN_FLIGHT + 1 },
      (_, i) => revalidateTag(`post:${i}`),
    );
    await flush();
    expect(frames).toHaveLength(MAX_REVALIDATIONS_IN_FLIGHT);
    await vi.advanceTimersByTimeAsync(REVALIDATE_TIMEOUT_MS);
    const results = await Promise.all(calls);
    expect(results.every(result => !result.ok)).toBe(true);
    expect(results.at(-1)).toMatchObject({ error: /behind earlier revalidations/ });
    expect(frames).toHaveLength(MAX_REVALIDATIONS_IN_FLIGHT);

    // The window is free again afterwards.
    const later = revalidateTag('posts');
    await flush();
    expect(frames).toHaveLength(MAX_REVALIDATIONS_IN_FLIGHT + 1);
    settleRevalidateAck({ type: 'revalidate_ack', id: frames.at(-1)!.id, ok: true, purged: 0 });
    await expect(later).resolves.toEqual({ ok: true, purged: 0 });
  });

  it('a respawned worker never reuses the ids of the one before it', async () => {
    const crashed = connect();
    void revalidateTag('posts');
    await flush();
    const oldId = crashed.frames[0]!.id;
    crashed.detach();

    resetBridge(); // a new worker process starts from a fresh bridge
    const respawned = connect();
    const pending = revalidateTag('users');
    await flush();
    const newId = respawned.frames[0]!.id;
    expect(newId).not.toBe(oldId);
    // Rust finishes the purge the crashed worker queued and acks it on the
    // new connection: it must not settle the new worker's call.
    settleRevalidateAck({ type: 'revalidate_ack', id: oldId, ok: true, purged: 7 });
    settleRevalidateAck({ type: 'revalidate_ack', id: newId, ok: true, purged: 1 });
    await expect(pending).resolves.toEqual({ ok: true, purged: 1 });
  });

  it('works across module instances (app code loads its own copy)', async () => {
    const { frames } = connect();
    vi.resetModules();
    const appCopy = await import('./revalidate.ts');
    const pending = appCopy.revalidateTag('posts');
    await flush();
    expect(frames).toHaveLength(1);
    settleRevalidateAck({ type: 'revalidate_ack', id: frames[0]!.id, ok: true, purged: 2 });
    await expect(pending).resolves.toEqual({ ok: true, purged: 2 });
  });
});

describe('outside the server', () => {
  it('is a no-op that warns once (gio export, tests)', async () => {
    const write = process.stderr.write as unknown as ReturnType<typeof vi.fn>;
    await expect(revalidateTag('posts')).resolves.toMatchObject({ ok: false, purged: 0 });
    await expect(revalidatePath('/blog')).resolves.toMatchObject({ ok: false, purged: 0 });
    const warnings = write.mock.calls.filter(([line]) =>
      String(line).includes('outside the GioJS server'),
    );
    expect(warnings).toHaveLength(1);
  });
});

describe('sanitizeCacheTags', () => {
  it('merges declarations, de-duplicates, and drops invalid tags', () => {
    expect(
      sanitizeCacheTags(
        [
          { source: 'export const tags', value: ['posts', '', 'posts', '_gio:x'] },
          { source: 'getServerSideProps tags', value: ['post:1', 3, 'a\tb'] },
          { source: 'unused', value: undefined },
        ],
        '/posts/:id',
      ),
    ).toEqual(['posts', 'post:1']);
  });

  it('ignores a declaration that is not an array', () => {
    expect(sanitizeCacheTags([{ source: 'export const tags', value: 'posts' }], '/')).toEqual([]);
  });

  it('drops tags with an unpaired surrogate, keeps whole emoji', () => {
    const title = '😀 launch day';
    expect(
      sanitizeCacheTags(
        [{ source: 'getServerSideProps tags', value: [`post:${title.slice(0, 1)}`, `post:${title.slice(0, 2)}`, '\udc00'] }],
        '/posts/:id',
      ),
    ).toEqual(['post:😀']);
  });

  it('caps at 64 tags and counts bytes, not characters', () => {
    const many = Array.from({ length: 70 }, (_, i) => `t${i}`);
    expect(sanitizeCacheTags([{ source: 's', value: many }], '/')).toHaveLength(64);
    const wide = 'é'.repeat(129); // 258 bytes in UTF-8
    expect(sanitizeCacheTags([{ source: 's', value: [wide, 'é'.repeat(128)] }], '/')).toEqual([
      'é'.repeat(128),
    ]);
  });
});

// ─── through the IPC server ───────────────────────────────────────────────────

function frame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(json.byteLength, 0);
  return Buffer.concat([header, json]);
}

function frameReader(
  socket: net.Socket,
): (predicate: (f: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>> {
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

describe.skipIf(process.platform === 'win32')('revalidation through the IPC server', () => {
  it('a route handler awaits the server ack of its revalidate frame', async () => {
    const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'giojs-ipc-reval-'));
    vi.stubEnv('GIO_SOCKET_PATH', nodePath.join(tmpDir, 'ipc.sock'));
    vi.stubEnv('GIO_IPC_TOKEN', '');
    vi.resetModules();
    // PIPE_PATH is read at import time. The handler below uses this test's
    // own copy of revalidate.ts, the way app code gets its own.
    const { createIPCServer } = await import('./ipc.ts');
    const handlers = new Map<string, HandlerEntry>([
      ['/api/publish', {
        filePath: '/fake/route.ts',
        urlPattern: '/api/publish',
        methods: new Map([['POST', async () => ({ result: await revalidateTag('posts') })]]),
      }],
    ]);
    const server = createIPCServer(
      new Map<string, RouteModule>(), new Map<string, LayoutEntry>(), new Map(),
      undefined, undefined, { handlers },
    );
    try {
      await once(server, 'listening');
      const client = net.connect(nodePath.join(tmpDir, 'ipc.sock'));
      await once(client, 'connect');
      const waitFrame = frameReader(client);
      await waitFrame(f => f['type'] === 'ready');
      client.write(frame({ type: 'ack', token: '' }));
      client.write(frame({
        id: 'req-1', method: 'POST', path: '/api/publish', params: {}, query: {},
        headers: {}, body: null, deploymentId: 'd', locale: '',
      }));

      const purge = await waitFrame(f => f['type'] === 'revalidate');
      expect(purge).toMatchObject({ tags: ['posts'], paths: [], prefix: false });
      client.write(frame({ type: 'revalidate_ack', id: purge['id'], ok: true, purged: 2 }));

      const response = await waitFrame(f => f['id'] === 'req-1');
      expect(JSON.parse(String(response['body']))).toEqual({ result: { ok: true, purged: 2 } });
      client.destroy();
    } finally {
      server.close();
      vi.unstubAllEnvs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * giojs-core/src/route-label.test.ts
 *
 * The IPC `route` field Rust labels its metrics with: which pattern owns a
 * path (same precedence as rendering), and how ipc.ts stamps it on frames.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { describe, it, expect, vi } from 'vitest';
import { resolveRoutePattern } from './ssr.ts';
import type { MetadataRoutes } from './metadata-routes.ts';
import { withRoute } from './ipc.ts';
import { NodePluginRegistry } from './plugin.ts';
import type { HandlerEntry, LayoutEntry, RouteModule } from './router.ts';
import type { IPCError, IPCRequest, IPCResponse } from './context.ts';

function pages(...patterns: string[]): Map<string, RouteModule> {
  return new Map(
    patterns.map(pattern => [
      pattern,
      {
        filePath: `/fake${pattern}/page.tsx`,
        urlPattern: pattern,
        dir: pattern.slice(1),
        load: () => Promise.resolve({ default: () => null }),
      },
    ]),
  );
}

function handlers(...patterns: string[]): Map<string, HandlerEntry> {
  return new Map(
    patterns.map(pattern => [
      pattern,
      { filePath: `/fake${pattern}/route.ts`, urlPattern: pattern, methods: new Map() },
    ]),
  );
}

describe('resolveRoutePattern', () => {
  it('labels a request with its pattern, never the raw path', () => {
    const routes = pages('/', '/posts/:id', '/docs/*slug');
    expect(resolveRoutePattern('/posts/42', routes)).toBe('/posts/:id');
    expect(resolveRoutePattern('/docs/a/b/c', routes)).toBe('/docs/*slug');
    expect(resolveRoutePattern('/', routes)).toBe('/');
  });

  it('prefers the most specific match, as rendering does', () => {
    const routes = pages('/posts/:id', '/posts/new');
    expect(resolveRoutePattern('/posts/new', routes)).toBe('/posts/new');
  });

  it('returns null when nothing matches (Rust says "unmatched")', () => {
    expect(resolveRoutePattern('/nowhere', pages('/posts/:id'))).toBeNull();
    expect(resolveRoutePattern('/nowhere', pages(), handlers())).toBeNull();
  });

  it('weighs route.ts handlers against pages by specificity', () => {
    // A more specific page wins over a catch-all handler...
    expect(resolveRoutePattern('/blog/about', pages('/blog/about'), handlers('/blog/:slug')))
      .toBe('/blog/about');
    // ...a more specific handler over a page...
    expect(resolveRoutePattern('/api/x', pages('/:any'), handlers('/api/x'))).toBe('/api/x');
    // ...and a same-folder pair shares its one pattern.
    expect(resolveRoutePattern('/feed', pages('/feed'), handlers('/feed'))).toBe('/feed');
    expect(resolveRoutePattern('/api/ping', pages(), handlers('/api/ping'))).toBe('/api/ping');
  });

  it('labels an app metadata route by its fixed path, ahead of any catch-all', () => {
    const sitemap: MetadataRoutes = {
      sitemap: { kind: 'sitemap', filePath: '/fake/sitemap.ts', load: async () => ({ default: [] }) },
    };
    expect(resolveRoutePattern('/sitemap.xml', pages('/*rest'), undefined, sitemap)).toBe('/sitemap.xml');
    // Without the module the URL is an ordinary path.
    expect(resolveRoutePattern('/robots.txt', pages('/*rest'), undefined, sitemap)).toBe('/*rest');
    expect(resolveRoutePattern('/robots.txt', pages(), undefined, sitemap)).toBeNull();
  });
});

describe('withRoute', () => {
  const response: IPCResponse = {
    id: 'r1',
    status: 200,
    headers: {},
    body: '',
    cacheable: false,
    cacheMaxAge: 0,
  };

  it('stamps the pattern on responses and error frames', () => {
    expect(withRoute(response, '/posts/:id').route).toBe('/posts/:id');
    const error: IPCError = { id: 'r1', error: true, code: 'RENDER_ERROR', message: 'x' };
    expect(withRoute(error, '/boom').route).toBe('/boom');
  });

  it('omits the field when no route matched, whatever a plugin put there', () => {
    const spoofed = withRoute({ ...response, route: '/admin' }, null);
    expect('route' in spoofed).toBe(false);
    expect(JSON.parse(JSON.stringify(withRoute(response, null)))).not.toHaveProperty('route');
    // The plugin's value never survives a real match either.
    expect(withRoute({ ...response, route: '/admin' }, '/posts/:id').route).toBe('/posts/:id');
  });

  it('leaves the original frame untouched', () => {
    withRoute(response, '/x');
    expect('route' in response).toBe(false);
  });
});

// ─── through the IPC server ───────────────────────────────────────────────────

function frame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(json.byteLength, 0);
  return Buffer.concat([header, json]);
}

/** Wait for the first length-prefixed JSON frame from `socket` matching a predicate. */
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

describe.skipIf(process.platform === 'win32')('IPC server route label', () => {
  it('labels the route a plugin rewrote the path to, not the requested one', async () => {
    const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'giojs-ipc-route-'));
    vi.stubEnv('GIO_SOCKET_PATH', nodePath.join(tmpDir, 'ipc.sock'));
    vi.stubEnv('GIO_IPC_TOKEN', '');
    vi.resetModules();
    // PIPE_PATH is read at import time.
    const { createIPCServer } = await import('./ipc.ts');

    const registry = new NodePluginRegistry();
    registry.register({
      name: 'legacy-urls',
      version: '0.0.0',
      onRequest: async (req: IPCRequest) =>
        req.path.startsWith('/old/') ? { ...req, path: req.path.replace(/^\/old\//, '/new/') } : req,
    });
    const server = createIPCServer(
      pages('/old/:x', '/new/:x'), new Map<string, LayoutEntry>(), new Map(), registry,
    );
    try {
      await once(server, 'listening');
      const client = net.connect(nodePath.join(tmpDir, 'ipc.sock'));
      await once(client, 'connect');
      const waitFrame = frameReader(client);
      await waitFrame(f => f['type'] === 'ready');
      client.write(frame({ type: 'ack', token: '' }));

      const routeOf = async (id: string, path: string): Promise<unknown> => {
        client.write(frame({
          id, method: 'GET', path, params: {}, query: {}, headers: {}, body: null,
          deploymentId: 'd', locale: '',
        }));
        // The response (or a streamed render's head) - not its chunk frames.
        const response = await waitFrame(f => f['id'] === id && 'status' in f);
        return response['route'];
      };
      // /old/7 matches /old/:x as requested, but renders /new/:x.
      expect(await routeOf('ipc-old', '/old/7')).toBe('/new/:x');
      expect(await routeOf('ipc-new', '/new/8')).toBe('/new/:x');
      client.destroy();
    } finally {
      server.close();
      vi.unstubAllEnvs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

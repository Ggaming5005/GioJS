/**
 * giojs-core/src/ssr.test.ts
 *
 * Unit tests for the three bugs fixed in P3.7:
 *   1. revalidate=false should produce cacheMaxAge=31536000, not 0
 *   2. getServerSideProps returning {redirect} should produce a 301/302
 *   3. layout.tsx wrappers are applied outermost-first around the page
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderRoute, serializeEnvelope, type StreamRenderResult } from './ssr.ts';
import { NodePluginRegistry } from './plugin.ts';
import type { IPCRequest } from './context.ts';
import type { RouteModule, LayoutEntry, PageModule, LayoutModule } from './router.ts';

function makeRequest(path: string, id = 'req-1'): IPCRequest {
  return {
    id,
    method: 'GET',
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

function makeRoute(
  pattern: string,
  pageOverrides: Partial<PageModule> = {},
): Map<string, RouteModule> {
  const routes = new Map<string, RouteModule>();
  routes.set(pattern, {
    filePath: '/fake/page.tsx',
    urlPattern: pattern,
    load: async () => ({
      default: function TestPage() {
        return React.createElement('div', null, 'page content');
      },
      ...pageOverrides,
    }),
  });
  return routes;
}

const noLayouts = new Map<string, LayoutEntry>();

// ─── Bug 2: revalidate caching ────────────────────────────────────────────────

describe('revalidate caching semantics', () => {
  it('revalidate=false produces cacheMaxAge=31536000 (cache forever)', async () => {
    const routes = makeRoute('/', { revalidate: false });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('cacheable' in result && result.cacheable).toBe(true);
    expect('cacheMaxAge' in result && result.cacheMaxAge).toBe(31536000);
  });

  it('revalidate=60 produces cacheMaxAge=60', async () => {
    const routes = makeRoute('/', { revalidate: 60 });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('cacheMaxAge' in result && result.cacheMaxAge).toBe(60);
  });

  it('revalidate=undefined produces cacheable=false', async () => {
    const routes = makeRoute('/');
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('cacheable' in result && result.cacheable).toBe(false);
    expect('cacheMaxAge' in result && result.cacheMaxAge).toBe(0);
  });
});

// ─── Bug 3: redirect support ──────────────────────────────────────────────────

describe('getServerSideProps redirect', () => {
  it('returns 302 with location header for temporary redirect', async () => {
    const routes = makeRoute('/', {
      getServerSideProps: async () => ({
        redirect: { destination: '/docs/getting-started', permanent: false },
      }),
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('status' in result && result.status).toBe(302);
    expect('headers' in result && result.headers['location']).toBe('/docs/getting-started');
    expect('body' in result && result.body).toBe('');
  });

  it('returns 301 for permanent redirect', async () => {
    const routes = makeRoute('/', {
      getServerSideProps: async () => ({
        redirect: { destination: '/new-home', permanent: true },
      }),
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('status' in result && result.status).toBe(301);
    expect('headers' in result && result.headers['location']).toBe('/new-home');
  });

  it('redirect response is not cacheable', async () => {
    const routes = makeRoute('/', {
      getServerSideProps: async () => ({
        redirect: { destination: '/elsewhere', permanent: false },
      }),
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('cacheable' in result && result.cacheable).toBe(false);
  });
});

// ─── getServerSideProps props extraction ─────────────────────────────────────

describe('getServerSideProps props extraction', () => {
  // The contract errors below are about the dev-mode message; production
  // replaces it with a generic one (see 'error details by mode').
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('extracts props from { props: {...} } wrapper (Next.js convention)', async () => {
    const routes = makeRoute('/', {
      getServerSideProps: async () => ({ props: { title: 'hello' } }),
      default: function Page(props: Record<string, unknown>) {
        return React.createElement('span', null, String(props['title']));
      },
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('body' in result && result.body).toContain('hello');
  });

  it('a gSSP returning undefined yields a RENDER_ERROR naming the contract, not an opaque TypeError', async () => {
    const routes = makeRoute('/posts/:id', {
      getServerSideProps: async () =>
        undefined as unknown as Record<string, unknown>,
    });
    const result = await renderRoute(makeRequest('/posts/7'), routes, noLayouts);
    expect('error' in result && result.error).toBe(true);
    expect('code' in result && result.code).toBe('RENDER_ERROR');
    const message = 'message' in result ? result.message : '';
    expect(message).toContain('getServerSideProps');
    expect(message).toContain('/posts/:id');
    expect(message).toContain('undefined');
    expect(message).not.toContain('Cannot read properties');
  });

  it('a gSSP returning null yields the same contract error naming null', async () => {
    const routes = makeRoute('/', {
      getServerSideProps: async () => null as unknown as Record<string, unknown>,
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('code' in result && result.code).toBe('RENDER_ERROR');
    expect('message' in result && result.message).toContain('null');
  });

  it('passes flat result directly when no props wrapper present', async () => {
    const routes = makeRoute('/', {
      getServerSideProps: async () => ({ title: 'flat' }),
      default: function Page(props: Record<string, unknown>) {
        return React.createElement('span', null, String(props['title']));
      },
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('body' in result && result.body).toContain('flat');
  });
});

// ─── Bug 1: layout wrapping ───────────────────────────────────────────────────

describe('layout wrapping', () => {
  function makeLayout(urlPrefix: string, wrapperClass: string): LayoutEntry {
    return {
      filePath: '/fake/layout.tsx',
      urlPrefix,
      load: async (): Promise<LayoutModule> => ({
        default: function TestLayout({ children }: { children: React.ReactNode; path?: string }) {
          return React.createElement('div', { className: wrapperClass }, children);
        },
      }),
    };
  }

  it('wraps page content in a single layout', async () => {
    const routes = makeRoute('/docs');
    const layouts = new Map<string, LayoutEntry>([
      ['/', makeLayout('/', 'root-layout')],
    ]);
    const result = await renderRoute(makeRequest('/docs'), routes, layouts);
    expect('body' in result && result.body).toContain('root-layout');
    expect('body' in result && result.body).toContain('page content');
  });

  it('applies nested layouts outermost-first', async () => {
    const routes = makeRoute('/docs/guide');
    const layouts = new Map<string, LayoutEntry>([
      ['/', makeLayout('/', 'root-layout')],
      ['/docs', makeLayout('/docs', 'docs-layout')],
    ]);
    const result = await renderRoute(makeRequest('/docs/guide'), routes, layouts);
    const body = 'body' in result ? result.body : '';
    // root-layout should appear before docs-layout in the HTML
    expect(body.indexOf('root-layout')).toBeLessThan(body.indexOf('docs-layout'));
    expect(body).toContain('page content');
  });

  it('skips the document wrapper when a root layout exists, keeping the #__gio boundary inside it', async () => {
    const routes = makeRoute('/');
    const layouts = new Map<string, LayoutEntry>([
      ['/', makeLayout('/', 'root-layout')],
    ]);
    const result = await renderRoute(makeRequest('/'), routes, layouts);
    const body = 'body' in result ? result.body : '';
    expect(body).not.toContain('<!DOCTYPE');
    // The hydration boundary always exists, nested inside the root layout.
    expect(body.indexOf('root-layout')).toBeLessThan(body.indexOf('id="__gio"'));
  });

  it('adds the document wrapper when no root layout exists', async () => {
    const routes = makeRoute('/');
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    const body = 'body' in result ? result.body : '';
    expect(body).toContain('<!DOCTYPE');
    expect(body).toContain('id="__gio"');
  });

  it('keeps the root layout outside the hydration boundary but inner layouts inside it', async () => {
    const routes = makeRoute('/docs/guide');
    const layouts = new Map<string, LayoutEntry>([
      ['/', makeLayout('/', 'root-layout')],
      ['/docs', makeLayout('/docs', 'docs-layout')],
    ]);
    const result = await renderRoute(makeRequest('/docs/guide'), routes, layouts);
    const body = 'body' in result ? result.body : '';
    const boundary = body.indexOf('id="__gio"');
    expect(body.indexOf('root-layout')).toBeLessThan(boundary);
    expect(body.indexOf('docs-layout')).toBeGreaterThan(boundary);
  });
});

// ─── Hydration envelope ───────────────────────────────────────────────────────

describe('hydration envelope', () => {
  it('emits the props script and bootstrap module when the route has a client bundle', async () => {
    const routes = makeRoute('/');
    const clientScripts = new Map([['/', '/_next/static/chunks/route-index-ABC.js']]);
    const result = await renderRoute(
      makeRequest('/'), routes, noLayouts, undefined, undefined, clientScripts,
    );
    const body = 'body' in result ? result.body : '';
    expect(body).toContain('id="__gio_props"');
    expect(body).toContain('type="application/json"');
    expect(body).toContain('"pattern":"/"');
    expect(body).toContain('/_next/static/chunks/route-index-ABC.js');
    expect(body).toContain('type="module"');
  });

  it('omits the envelope and bootstrap script when the route has no bundle', async () => {
    const routes = makeRoute('/');
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    const body = 'body' in result ? result.body : '';
    expect(body).not.toContain('id="__gio_props"');
    expect(body).not.toContain('type="module"');
  });

  it('escapes </script> and <!-- inside serialized props', () => {
    const json = serializeEnvelope({
      props: { html: '</script><script>alert(1)</script>', c: '<!--' },
      path: '/', pattern: '/', entry: '/e.js',
    });
    expect(json).not.toBeNull();
    expect(json).not.toContain('<');
    expect(JSON.parse(json ?? '')).toEqual({
      props: { html: '</script><script>alert(1)</script>', c: '<!--' },
      path: '/', pattern: '/', entry: '/e.js',
    });
  });

  it('returns null for non-serializable props instead of emitting bad JSON', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(serializeEnvelope({ props: circular, path: '/', pattern: '/', entry: '' })).toBeNull();
  });
});

// ─── streaming SSR ────────────────────────────────────────────────────────────

async function readStreamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

function expectStream(result: Awaited<ReturnType<typeof renderRoute>>): StreamRenderResult {
  if ('type' in result && result.type === 'stream') return result;
  throw new Error(`expected a stream result, got ${JSON.stringify(result).slice(0, 200)}`);
}

describe('streaming SSR', () => {
  const streamingExtras = { streaming: true };

  it('streams uncacheable page renders when streaming is enabled', async () => {
    const routes = makeRoute('/');
    const result = await renderRoute(
      makeRequest('/'), routes, noLayouts, undefined, undefined, undefined, streamingExtras,
    );
    const streamed = expectStream(result);
    expect(streamed.head.streaming).toBe(true);
    expect(streamed.head.body).toBe('');
    expect(streamed.head.status).toBe(200);
    expect(streamed.head.cacheable).toBe(false);
    expect(streamed.head.headers['content-type']).toContain('text/html');
    const html = streamed.prefix + (await readStreamToString(streamed.stream)) + streamed.suffix;
    expect(html).toContain('<!DOCTYPE');
    expect(html).toContain('page content');
    expect(html).toContain('id="__gio"');
    expect(html).toContain('</html>');
  });

  it('keeps cacheable pages on the buffered path', async () => {
    const routes = makeRoute('/', { revalidate: 60 });
    const result = await renderRoute(
      makeRequest('/'), routes, noLayouts, undefined, undefined, undefined, streamingExtras,
    );
    expect('type' in result).toBe(false);
    expect('body' in result && result.body).toContain('page content');
    expect('cacheMaxAge' in result && result.cacheMaxAge).toBe(60);
  });

  it('keeps rendering buffered without the streaming opt-in', async () => {
    const routes = makeRoute('/');
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('type' in result).toBe(false);
    expect('body' in result && result.body).toContain('page content');
  });

  it('keeps HEAD requests buffered', async () => {
    const routes = makeRoute('/');
    const req = { ...makeRequest('/'), method: 'HEAD' };
    const result = await renderRoute(
      req, routes, noLayouts, undefined, undefined, undefined, streamingExtras,
    );
    expect('type' in result).toBe(false);
    expect('status' in result && result.status).toBe(200);
  });

  it('keeps rendering buffered when a plugin registered onResponse', async () => {
    const registry = new NodePluginRegistry();
    registry.register({
      name: 'test', version: '0.0.0',
      onResponse: async (_req, res) => ({ ...res, headers: { ...res.headers, 'x-seen': '1' } }),
    });
    const routes = makeRoute('/');
    const result = await renderRoute(
      makeRequest('/'), routes, noLayouts, registry, undefined, undefined, streamingExtras,
    );
    expect('type' in result).toBe(false);
    expect('headers' in result && result.headers['x-seen']).toBe('1');
  });

  it('streams without the document wrapper when a root layout provides the shell', async () => {
    const routes = makeRoute('/');
    const layouts = new Map<string, LayoutEntry>([
      ['/', {
        filePath: '/fake/layout.tsx',
        urlPrefix: '/',
        load: async () => ({
          default: function RootLayout({ children }: { children?: React.ReactNode }) {
            return React.createElement('html', null,
              React.createElement('head', null),
              React.createElement('body', null, children));
          },
        }),
      }],
    ]);
    const result = await renderRoute(
      makeRequest('/'), routes, layouts, undefined, undefined, undefined, streamingExtras,
    );
    const streamed = expectStream(result);
    expect(streamed.prefix).toBe('');
    expect(streamed.suffix).toBe('');
    const html = await readStreamToString(streamed.stream);
    expect(html).toContain('<html');
    expect(html).toContain('page content');
  });
});

// ─── PPR (shell='cache') ──────────────────────────────────────────────────────

describe('PPR shell caching', () => {
  const streamingExtras = { streaming: true };

  it("shell='cache' with revalidate streams with pprShell and a mark boundary", async () => {
    const routes = makeRoute('/', { shell: 'cache', revalidate: 60 });
    const result = await renderRoute(
      makeRequest('/'), routes, noLayouts, undefined, undefined, undefined, streamingExtras,
    );
    const streamed = expectStream(result);
    expect(streamed.head.pprShell).toBe(true);
    expect(streamed.head.streaming).toBe(true);
    expect(streamed.head.cacheable).toBe(true);
    expect(streamed.head.cacheMaxAge).toBe(60);
    expect(streamed.shellBoundary).toBe('mark');
  });

  it("shell='cache' without revalidate falls back to plain streaming", async () => {
    const routes = makeRoute('/', { shell: 'cache' });
    const result = await renderRoute(
      makeRequest('/'), routes, noLayouts, undefined, undefined, undefined, streamingExtras,
    );
    const streamed = expectStream(result);
    expect(streamed.head.pprShell).toBeUndefined();
    expect(streamed.head.cacheable).toBe(false);
    expect(streamed.shellBoundary).toBeUndefined();
  });

  it('skipShell requests stream with a discard boundary and an uncacheable head', async () => {
    const routes = makeRoute('/', { shell: 'cache', revalidate: 60 });
    const req = { ...makeRequest('/'), skipShell: true };
    const result = await renderRoute(
      req, routes, noLayouts, undefined, undefined, undefined, streamingExtras,
    );
    const streamed = expectStream(result);
    expect(streamed.shellBoundary).toBe('discard');
    expect(streamed.head.pprShell).toBeUndefined();
    expect(streamed.head.cacheable).toBe(false);
    expect(streamed.head.cacheMaxAge).toBe(0);
  });

  it("shell='cache' stays buffered without the streaming opt-in (static export)", async () => {
    const routes = makeRoute('/', { shell: 'cache', revalidate: 60 });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('type' in result).toBe(false);
    expect('body' in result && result.body).toContain('page content');
    expect('cacheMaxAge' in result && result.cacheMaxAge).toBe(60);
  });
});

// ─── route.ts method handlers ─────────────────────────────────────────────────

import type { HandlerEntry, RouteHandlerFn } from './router.ts';
import type { GioRequest } from './context.ts';

function makeHandlers(
  pattern: string,
  methods: Record<string, RouteHandlerFn>,
): Map<string, HandlerEntry> {
  return new Map([
    [pattern, { filePath: '/fake/route.ts', urlPattern: pattern, methods: new Map(Object.entries(methods)) }],
  ]);
}

describe('route.ts method handlers', () => {
  it('dispatches POST with parsed params, cookies, and JSON body', async () => {
    let seen: GioRequest | undefined;
    const handlers = makeHandlers('/api/notes/:id', {
      POST: (gioReq) => {
        seen = gioReq;
        return { saved: gioReq.json<{ text: string }>().text, id: gioReq.params['id'] };
      },
    });
    const req: IPCRequest = {
      ...makeRequest('/api/notes/42'),
      method: 'POST',
      body: '{"text":"hi"}',
      headers: { cookie: 'session=abc; theme=dark' },
    };
    const result = await renderRoute(req, new Map(), noLayouts, undefined, undefined, undefined, {
      handlers,
    });
    expect('status' in result && result.status).toBe(200);
    expect('headers' in result && result.headers['content-type']).toContain('application/json');
    expect('body' in result && JSON.parse(result.body)).toEqual({ saved: 'hi', id: '42' });
    expect('cacheable' in result && result.cacheable).toBe(false);
    expect(seen?.cookies).toEqual({ session: 'abc', theme: 'dark' });
    expect(seen?.method).toBe('POST');
  });

  it('passes web-standard Response objects through', async () => {
    const handlers = makeHandlers('/api/thing', {
      DELETE: () => new Response('gone', { status: 202, headers: { 'X-Custom': 'yes' } }),
    });
    const req = { ...makeRequest('/api/thing'), method: 'DELETE' };
    const result = await renderRoute(req, new Map(), noLayouts, undefined, undefined, undefined, {
      handlers,
    });
    expect('status' in result && result.status).toBe(202);
    expect('headers' in result && result.headers['x-custom']).toBe('yes');
    expect('body' in result && result.body).toBe('gone');
  });

  it('returns 405 with Allow for unexported methods', async () => {
    const handlers = makeHandlers('/api/thing', { POST: () => ({ ok: true }) });
    const req = { ...makeRequest('/api/thing'), method: 'PUT' };
    const result = await renderRoute(req, new Map(), noLayouts, undefined, undefined, undefined, {
      handlers,
    });
    expect('status' in result && result.status).toBe(405);
    expect('headers' in result && result.headers['allow']).toBe('POST');
  });

  it('returns 405 for mutations aimed at pages', async () => {
    const routes = makeRoute('/');
    const req = { ...makeRequest('/'), method: 'POST' };
    const result = await renderRoute(req, routes, noLayouts);
    expect('status' in result && result.status).toBe(405);
    expect('headers' in result && result.headers['allow']).toContain('GET');
  });

  it('a throwing handler yields a JSON 500, not an HTML error', async () => {
    const handlers = makeHandlers('/api/boom', {
      GET: () => { throw new Error('kaboom'); },
    });
    const result = await renderRoute(
      makeRequest('/api/boom'), new Map(), noLayouts, undefined, undefined, undefined, { handlers },
    );
    expect('status' in result && result.status).toBe(500);
    expect('headers' in result && result.headers['content-type']).toContain('application/json');
    expect('body' in result && result.body).not.toContain('kaboom');
  });

  it('null/undefined handler results become 204', async () => {
    const handlers = makeHandlers('/api/fire', { POST: () => undefined });
    const req = { ...makeRequest('/api/fire'), method: 'POST' };
    const result = await renderRoute(req, new Map(), noLayouts, undefined, undefined, undefined, {
      handlers,
    });
    expect('status' in result && result.status).toBe(204);
  });
});

// ─── getServerSideProps context + response headers ────────────────────────────

describe('getServerSideProps context', () => {
  it('receives method, path, headers, and parsed cookies', async () => {
    let ctxSeen: Record<string, unknown> | undefined;
    const routes = makeRoute('/', {
      getServerSideProps: async (ctx) => {
        ctxSeen = ctx as unknown as Record<string, unknown>;
        return { props: { user: (ctx as { cookies: Record<string, string> }).cookies['session'] ?? 'anon' } };
      },
      default: function Page(props: Record<string, unknown>) {
        return React.createElement('b', null, String(props['user']));
      },
    });
    const req = { ...makeRequest('/'), headers: { cookie: 'session=u1', 'x-thing': 'v' } };
    const result = await renderRoute(req, routes, noLayouts);
    expect('body' in result && result.body).toContain('u1');
    expect(ctxSeen?.['method']).toBe('GET');
    expect(ctxSeen?.['path']).toBe('/');
    expect((ctxSeen?.['headers'] as unknown as Record<string, string>)['x-thing']).toBe('v');
  });

  it('merges returned headers into the response and forces it uncacheable', async () => {
    const routes = makeRoute('/', {
      revalidate: 60,
      getServerSideProps: async () => ({
        props: { ok: true },
        headers: { 'set-cookie': 'visited=1; Path=/' },
      }),
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('headers' in result && result.headers['set-cookie']).toBe('visited=1; Path=/');
    // Caching a per-request set-cookie would replay it to every visitor.
    expect('cacheable' in result && result.cacheable).toBe(false);
    expect('cacheMaxAge' in result && result.cacheMaxAge).toBe(0);
  });

  it('flat results containing a headers key stay plain props', async () => {
    const routes = makeRoute('/', {
      getServerSideProps: async () => ({ title: 'flat', headers: 'not-response-headers' }),
      default: function Page(props: Record<string, unknown>) {
        return React.createElement('i', null, `${props['title']}-${props['headers']}`);
      },
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('body' in result && result.body).toContain('flat-not-response-headers');
    expect('headers' in result && result.headers['set-cookie']).toBeUndefined();
  });
});

// ─── special pages ────────────────────────────────────────────────────────────

describe('special pages', () => {
  const specialPages = {
    notFound: async () => ({
      default: function NotFound() {
        return React.createElement('h1', null, 'CUSTOM_404_PAGE');
      },
    }),
    error: async () => ({
      default: function ErrorPage({ error }: { error?: { message: string } }) {
        return React.createElement('h1', null, `CUSTOM_500 ${error?.message ?? ''}`);
      },
    }),
  };

  it('renders app/not-found for unmatched paths with status 404', async () => {
    const result = await renderRoute(
      makeRequest('/nope'), new Map(), noLayouts, undefined, undefined, undefined, { specialPages },
    );
    expect('status' in result && result.status).toBe(404);
    expect('body' in result && result.body).toContain('CUSTOM_404_PAGE');
    expect('body' in result && result.body).toContain('id="__gio"');
    expect('cacheable' in result && result.cacheable).toBe(false);
  });

  it('renders app/error with the failure message in dev mode', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    try {
      const routes = makeRoute('/', {
        getServerSideProps: async () => { throw new Error('db exploded'); },
      });
      const result = await renderRoute(
        makeRequest('/'), routes, noLayouts, undefined, undefined, undefined, { specialPages },
      );
      expect('status' in result && result.status).toBe(500);
      expect('body' in result && result.body).toContain('CUSTOM_500 db exploded');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('renders app/error with a generic message outside dev mode', async () => {
    const routes = makeRoute('/', {
      getServerSideProps: async () => { throw new Error('db exploded'); },
    });
    const result = await renderRoute(
      makeRequest('/'), routes, noLayouts, undefined, undefined, undefined, { specialPages },
    );
    expect('status' in result && result.status).toBe(500);
    expect('body' in result && result.body).toContain('CUSTOM_500 Internal Server Error');
    expect('body' in result && result.body).not.toContain('db exploded');
  });

  it('falls back to the built-in 404 when no not-found page exists', async () => {
    const result = await renderRoute(makeRequest('/nope'), new Map(), noLayouts);
    expect('status' in result && result.status).toBe(404);
    expect('body' in result && result.body).toContain('HTTP 404');
    expect('body' in result && result.body).toContain('Page not found');
  });
});

// ─── error details by mode ────────────────────────────────────────────────────

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

const DIGEST = /^[0-9a-f]{12}$/;

describe('error details by mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function throwingRoute(): Map<string, RouteModule> {
    return makeRoute('/', {
      getServerSideProps: async () => { throw new Error('secret db password in message'); },
    });
  }

  it('production error frames carry a generic message and a digest, never the stack', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const logs = captureLogs();
    let result;
    try {
      result = await renderRoute(makeRequest('/'), throwingRoute(), noLayouts);
    } finally {
      logs.restore();
    }
    expect('error' in result && result.error).toBe(true);
    expect('message' in result && result.message).toBe('Internal Server Error');
    expect('stack' in result).toBe(false);
    const digest = 'digest' in result ? result.digest : undefined;
    expect(digest).toMatch(DIGEST);
    // The operator-facing log line carries the real message + stack under the same digest.
    const line = logs.lines().find(l => l['msg'] === 'ssr render failed');
    expect(line?.['digest']).toBe(digest);
    expect(line?.['error']).toBe('secret db password in message');
    expect(String(line?.['stack'])).toContain('secret db password in message');
  });

  it('an unset or test NODE_ENV is production, not dev', async () => {
    for (const value of ['', 'test']) {
      vi.stubEnv('NODE_ENV', value);
      const result = await renderRoute(makeRequest('/'), throwingRoute(), noLayouts);
      expect('message' in result && result.message).toBe('Internal Server Error');
    }
  });

  it('dev error frames keep the real message and stack, plus the digest', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const result = await renderRoute(makeRequest('/'), throwingRoute(), noLayouts);
    expect('message' in result && result.message).toBe('secret db password in message');
    expect('stack' in result && result.stack).toContain('secret db password in message');
    expect('digest' in result && result.digest).toMatch(DIGEST);
  });

  it('app/error receives { message, digest } - generic in production, real in dev', async () => {
    let seen: { message: string; digest?: string } | undefined;
    const specialPages = {
      error: async () => ({
        default: function ErrorPage(props: Record<string, unknown>) {
          const error = props['error'] as { message: string; digest?: string };
          seen = error;
          return React.createElement('h1', null, `ref ${error.digest ?? ''}`);
        },
      }),
    };
    const render = () => renderRoute(
      makeRequest('/'), throwingRoute(), noLayouts, undefined, undefined, undefined, { specialPages },
    );

    vi.stubEnv('NODE_ENV', 'production');
    const prod = await render();
    expect(seen?.message).toBe('Internal Server Error');
    expect(seen?.digest).toMatch(DIGEST);
    expect('body' in prod && prod.body).toContain(`ref ${seen?.digest}`);
    expect('body' in prod && prod.body).not.toContain('secret');

    vi.stubEnv('NODE_ENV', 'development');
    await render();
    expect(seen?.message).toBe('secret db password in message');
    expect(seen?.digest).toMatch(DIGEST);
  });

  it('route handler failures return a generic JSON body with the logged digest', async () => {
    const handlers = makeHandlers('/api/boom', {
      GET: () => { throw new Error('handler secret'); },
    });
    const logs = captureLogs();
    let result;
    try {
      result = await renderRoute(
        makeRequest('/api/boom'), new Map(), noLayouts, undefined, undefined, undefined, { handlers },
      );
    } finally {
      logs.restore();
    }
    expect('status' in result && result.status).toBe(500);
    const body = JSON.parse('body' in result ? result.body : '{}') as Record<string, unknown>;
    expect(body['error']).toBe('Internal Server Error');
    expect(body['digest']).toMatch(DIGEST);
    expect(JSON.stringify(body)).not.toContain('handler secret');
    const line = logs.lines().find(l => l['msg'] === 'route handler failed');
    expect(line?.['digest']).toBe(body['digest']);
    expect(line?.['error']).toBe('handler secret');
  });
});

// ─── personalized renders (dynamic detection) ─────────────────────────────────

interface GsspContextLike {
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  cookies: Record<string, string>;
}

describe('credential reads make a revalidate page uncacheable', () => {
  const credentialRequest = (path = '/'): IPCRequest => ({
    ...makeRequest(path),
    headers: { cookie: 'session=u1', authorization: 'Bearer t', 'x-thing': 'v', 'accept-language': 'fr' },
  });

  function gsspRoute(
    pattern: string,
    read: (ctx: GsspContextLike) => unknown,
    overrides: Partial<PageModule> = {},
  ): Map<string, RouteModule> {
    return makeRoute(pattern, {
      revalidate: 60,
      getServerSideProps: async (ctx) => ({ props: { v: String(read(ctx as GsspContextLike)) } }),
      ...overrides,
    });
  }

  async function cacheFields(
    routes: Map<string, RouteModule>,
    req: IPCRequest = credentialRequest(),
    registry?: NodePluginRegistry,
  ): Promise<{ cacheable: unknown; cacheMaxAge: unknown }> {
    const result = await renderRoute(req, routes, noLayouts, registry);
    return {
      cacheable: 'cacheable' in result ? result.cacheable : undefined,
      cacheMaxAge: 'cacheMaxAge' in result ? result.cacheMaxAge : undefined,
    };
  }

  const PERSONAL = { cacheable: false, cacheMaxAge: 0 };
  const SHARED = { cacheable: true, cacheMaxAge: 60 };

  it('reading ctx.cookies makes the render personal', async () => {
    expect(await cacheFields(gsspRoute('/', ctx => ctx.cookies['session']))).toEqual(PERSONAL);
  });

  it('reading the cookie or authorization header makes the render personal', async () => {
    expect(await cacheFields(gsspRoute('/', ctx => ctx.headers['cookie']))).toEqual(PERSONAL);
    expect(await cacheFields(gsspRoute('/', ctx => ctx.headers['authorization']))).toEqual(PERSONAL);
  });

  it('probing or enumerating the headers counts as a read', async () => {
    expect(await cacheFields(gsspRoute('/', ctx => 'cookie' in ctx.headers))).toEqual(PERSONAL);
    expect(await cacheFields(gsspRoute('/', ctx => JSON.stringify({ ...ctx.headers })))).toEqual(PERSONAL);
  });

  it('a read counts even when the request carries no credentials (the anonymous variant)', async () => {
    const routes = gsspRoute('/', ctx => ctx.cookies['session'] ?? 'anon');
    expect(await cacheFields(routes, makeRequest('/'))).toEqual(PERSONAL);
  });

  it('reading non-credential headers keeps the page cacheable', async () => {
    const routes = gsspRoute('/', ctx => `${ctx.headers['x-thing']}-${ctx.headers['accept-language']}`);
    expect(await cacheFields(routes)).toEqual(SHARED);
  });

  it('a page that never reads credentials stays cacheable even when they are sent', async () => {
    expect(await cacheFields(gsspRoute('/', ctx => ctx.path))).toEqual(SHARED);
    expect(await cacheFields(makeRoute('/', { revalidate: 60 }))).toEqual(SHARED);
  });

  it('framework reads of the request (hydration envelope included) never trigger it', async () => {
    const routes = gsspRoute('/', ctx => ctx.query['q'] ?? 'none');
    const clientScripts = new Map([['/', '/e.js']]);
    const result = await renderRoute(
      credentialRequest(), routes, noLayouts, undefined, undefined, clientScripts,
    );
    expect('body' in result && result.body).toContain('__gio_props');
    expect('cacheable' in result && result.cacheable).toBe(true);
  });

  it('credentials carried into the render through props are caught before caching', async () => {
    const routes = makeRoute('/', {
      revalidate: 60,
      getServerSideProps: async (ctx) => ({ props: { headers: ctx.headers } }),
      default: function Page(props: Record<string, unknown>) {
        const headers = props['headers'] as Record<string, string>;
        return React.createElement('b', null, headers['cookie'] ?? 'anon');
      },
    });
    const result = await renderRoute(credentialRequest(), routes, noLayouts);
    expect('body' in result && result.body).toContain('session=u1');
    expect('cacheable' in result && result.cacheable).toBe(false);
  });

  it('headers derived by an onRequest plugin count as credentials', async () => {
    const registry = new NodePluginRegistry();
    registry.register({
      name: 'auth',
      version: '1.0.0',
      onRequest: async (req) => {
        req.headers['x-user-id'] = req.headers['cookie'] === 'session=u1' ? 'u1' : 'anon';
        return req;
      },
    });
    expect(
      await cacheFields(gsspRoute('/', ctx => ctx.headers['x-user-id']), credentialRequest(), registry),
    ).toEqual(PERSONAL);
    expect(
      await cacheFields(gsspRoute('/', ctx => ctx.headers['x-thing']), credentialRequest(), registry),
    ).toEqual(SHARED);
  });

  it('warns once per route with the way out', async () => {
    const logs = captureLogs();
    try {
      const routes = gsspRoute('/warn-once', ctx => ctx.cookies['session']);
      await cacheFields(routes, credentialRequest('/warn-once'));
      await cacheFields(routes, credentialRequest('/warn-once'));
    } finally {
      logs.restore();
    }
    const warnings = logs.lines().filter(l => String(l['msg']).includes('read request credentials'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.['route']).toBe('/warn-once');
    expect(String(warnings[0]?.['msg'])).toContain("shell = 'cache'");
  });

  it('pages without revalidate are unaffected and do not warn', async () => {
    const logs = captureLogs();
    let fields;
    try {
      fields = await cacheFields(
        makeRoute('/no-revalidate', {
          getServerSideProps: async (ctx) => ({ props: { v: ctx.cookies['session'] } }),
        }),
        credentialRequest('/no-revalidate'),
      );
    } finally {
      logs.restore();
    }
    expect(fields).toEqual(PERSONAL);
    expect(logs.lines().some(l => String(l['msg']).includes('read request credentials'))).toBe(false);
  });

  describe('PPR (shell=cache)', () => {
    const streamingExtras = { streaming: true };
    const clientScripts = new Map([['/', '/e.js']]);
    const pprRoute = gsspRoute('/', ctx => ctx.cookies['session'], { shell: 'cache' });

    it('keeps the shell cacheable and moves the per-request envelope out of it', async () => {
      const result = await renderRoute(
        credentialRequest(), pprRoute, noLayouts, undefined, undefined, clientScripts, streamingExtras,
      );
      const streamed = expectStream(result);
      expect(streamed.head.pprShell).toBe(true);
      expect(streamed.head.cacheable).toBe(true);
      expect(streamed.shellBoundary).toBe('mark');
      // The props (u1's session) travel in the deferred envelope, not the React stream.
      expect(streamed.envelope).toContain('id="__gio_props"');
      expect(streamed.envelope).toContain('"v":"u1"');
      const html = await readStreamToString(streamed.stream);
      expect(html).not.toContain('__gio_props');
      expect(html).not.toContain('u1');
      // The bootstrap module stays in the shell - it is the same for everyone.
      expect(html).toContain('/e.js');
    });

    it('skipShell (holes) renders carry their own envelope for the boundary', async () => {
      const req = { ...credentialRequest(), skipShell: true };
      const streamed = expectStream(
        await renderRoute(req, pprRoute, noLayouts, undefined, undefined, clientScripts, streamingExtras),
      );
      expect(streamed.shellBoundary).toBe('discard');
      expect(streamed.envelope).toContain('"v":"u1"');
    });

    it('plain (non-PPR) streams keep the envelope inline', async () => {
      const routes = makeRoute('/', {
        getServerSideProps: async (ctx) => ({ props: { v: ctx.cookies['session'] } }),
      });
      const streamed = expectStream(
        await renderRoute(
          credentialRequest(), routes, noLayouts, undefined, undefined, clientScripts, streamingExtras,
        ),
      );
      expect(streamed.envelope).toBeUndefined();
      expect(await readStreamToString(streamed.stream)).toContain('__gio_props');
    });

    it('a PPR page rendered without a shell boundary (HEAD) is never cached whole', async () => {
      const req = { ...credentialRequest(), method: 'HEAD' };
      const result = await renderRoute(
        req, pprRoute, noLayouts, undefined, undefined, clientScripts, streamingExtras,
      );
      expect('type' in result).toBe(false);
      expect('cacheable' in result && result.cacheable).toBe(false);
    });
  });
});

/**
 * giojs-core/src/ssr.test.ts
 *
 * Unit tests for the three bugs fixed in P3.7:
 *   1. revalidate=false should produce cacheMaxAge=31536000, not 0
 *   2. getServerSideProps returning {redirect} should produce a 301/302
 *   3. layout.tsx wrappers are applied outermost-first around the page
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderRoute, serializeEnvelope } from './ssr.ts';
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

  it('renders app/error with the failure message when a page render throws', async () => {
    const routes = makeRoute('/', {
      getServerSideProps: async () => { throw new Error('db exploded'); },
    });
    const result = await renderRoute(
      makeRequest('/'), routes, noLayouts, undefined, undefined, undefined, { specialPages },
    );
    expect('status' in result && result.status).toBe(500);
    expect('body' in result && result.body).toContain('CUSTOM_500 db exploded');
  });

  it('falls back to the built-in 404 when no not-found page exists', async () => {
    const result = await renderRoute(makeRequest('/nope'), new Map(), noLayouts);
    expect('status' in result && result.status).toBe(404);
    expect('body' in result && result.body).toContain('HTTP 404');
    expect('body' in result && result.body).toContain('Page not found');
  });
});

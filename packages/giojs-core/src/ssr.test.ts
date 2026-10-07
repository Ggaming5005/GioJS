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
import {
  renderRoute,
  serializeEnvelope,
  flattenResponseHeaders,
  type StreamRenderResult,
} from './ssr.ts';
import { clearClientBuildErrors, recordClientBuildError } from './client-build-errors.ts';
import { cspNonce } from './csp.ts';
import {
  isJsonContentType,
  isUnsupportedMediaTypeError,
  UnsupportedMediaTypeError,
} from './request-body.ts';
import { installImageConfig, installedImageConfig } from './image-config.ts';
import { NodePluginRegistry } from './plugin.ts';
import { pumpRenderStream } from './ipc.ts';
import type { IPCRequest } from './context.ts';
import { emptySegmentFiles } from './router.ts';
import type { RouteModule, LayoutEntry, PageModule, LayoutModule, GsspContext } from './router.ts';

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
  // app/-relative page directory; for static patterns it mirrors the URL.
  dir = pattern.slice(1),
): Map<string, RouteModule> {
  const routes = new Map<string, RouteModule>();
  routes.set(pattern, {
    filePath: '/fake/page.tsx',
    urlPattern: pattern,
    dir,
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

function bodyOf(result: Awaited<ReturnType<typeof renderRoute>>): string {
  return 'body' in result ? result.body : '';
}

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

  it('revalidate=0 is a valid lifetime', async () => {
    const result = await renderRoute(makeRequest('/'), makeRoute('/', { revalidate: 0 }), noLayouts);
    expect('cacheMaxAge' in result && result.cacheMaxAge).toBe(0);
  });

  // These reached Rust as cacheMaxAge, which failed to parse the frame: a
  // bare 500 with no hint on every request.
  const invalid: Array<[unknown, string]> = [
    [-5, '-5'],
    [1.5, '1.5'],
    ['60', '"60"'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [true, 'boolean'],
  ];
  for (const [value, shown] of invalid) {
    it(`revalidate=${shown} is a render error naming the file`, async () => {
      vi.stubEnv('NODE_ENV', 'development');
      try {
        const routes = makeRoute('/', { revalidate: value as number });
        const result = await renderRoute(makeRequest('/'), routes, noLayouts);
        expect(result).toMatchObject({
          error: true,
          code: 'RENDER_ERROR',
          message:
            '/fake/page.tsx: export const revalidate must be a whole number of seconds (0 or more) ' +
            `or false - got ${shown}`,
        });
        expect('cacheMaxAge' in result).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  }

  it('an invalid revalidate answers production with only a digest', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const result = await renderRoute(makeRequest('/'), makeRoute('/', { revalidate: -1 }), noLayouts);
      expect(result).toMatchObject({ error: true, code: 'RENDER_ERROR', message: 'Internal Server Error' });
      expect('digest' in result && typeof result.digest).toBe('string');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('cache tags', () => {
  function cacheTagsOf(result: Awaited<ReturnType<typeof renderRoute>>): string[] | undefined {
    return 'cacheTags' in result ? result.cacheTags : undefined;
  }

  it('sends export const tags plus getServerSideProps tags, de-duplicated', async () => {
    const routes = makeRoute('/posts/:id', {
      revalidate: 60,
      tags: ['posts'],
      getServerSideProps: async ctx => ({
        props: { id: ctx.params['id'] },
        tags: [`post:${ctx.params['id']}`, 'posts'],
      }),
    }, 'posts/[id]');
    const req = { ...makeRequest('/posts/42'), params: {} };
    const result = await renderRoute(req, routes, noLayouts);
    expect(cacheTagsOf(result)).toEqual(['posts', 'post:42']);
  });

  it('drops invalid tags instead of failing the render', async () => {
    const routes = makeRoute('/', {
      revalidate: 60,
      tags: ['ok', '', 'x'.repeat(257), '_gio:path:/', 'bad\ntag', 42 as unknown as string],
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('status' in result && result.status).toBe(200);
    expect(cacheTagsOf(result)).toEqual(['ok']);
  });

  it('drops a tag with an unpaired surrogate, so the response frame stays valid JSON for Rust', async () => {
    const routes = makeRoute('/posts/:id', {
      revalidate: 60,
      getServerSideProps: async () => ({
        props: {},
        tags: ['post:42', `title:${'😀 launch'.slice(0, 1)}`],
      }),
    }, 'posts/[id]');
    const result = await renderRoute({ ...makeRequest('/posts/42'), params: {} }, routes, noLayouts);
    expect('status' in result && result.status).toBe(200);
    expect(cacheTagsOf(result)).toEqual(['post:42']);
    expect(JSON.stringify(cacheTagsOf(result))).not.toMatch(/\\u[dD][89abAB]/);
  });

  it('caps a render at 64 tags and ignores a non-array declaration', async () => {
    const many = Array.from({ length: 80 }, (_, i) => `t${i}`);
    const routes = makeRoute('/', {
      revalidate: 60,
      tags: 'posts' as unknown as string[],
      getServerSideProps: async () => ({ props: {}, tags: many }),
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect(cacheTagsOf(result)).toEqual(many.slice(0, 64));
  });

  it('flat props named tags stay props', async () => {
    const routes = makeRoute('/', {
      revalidate: 60,
      getServerSideProps: async () => ({ tags: ['a-prop'] }),
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect(cacheTagsOf(result)).toBeUndefined();
  });

  it('uncacheable renders carry no tags', async () => {
    const routes = makeRoute('/', { tags: ['posts'] });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect(cacheTagsOf(result)).toBeUndefined();
  });

  it('an uncached page exporting a `tags` of its own logs no cache-tag warning', async () => {
    const logs = captureLogs();
    try {
      // Tags are only read for cached pages; this one renders its tag cloud.
      for (const revalidate of [undefined, 0]) {
        const routes = makeRoute('/tag-cloud', {
          ...(revalidate !== undefined ? { revalidate } : {}),
          tags: [{ name: 'react' }] as unknown as string[],
        });
        const result = await renderRoute(makeRequest('/tag-cloud'), routes, noLayouts);
        expect('status' in result && result.status).toBe(200);
        expect(cacheTagsOf(result)).toBeUndefined();
      }
      expect(logs.lines().filter(l => String(l['msg']).includes('cache tags ignored'))).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  it('a PPR shell head carries the tags its cached shell is stored with', async () => {
    const routes = makeRoute('/', { shell: 'cache', revalidate: 60, tags: ['feed'] });
    const result = await renderRoute(
      makeRequest('/'), routes, noLayouts, undefined, undefined, undefined, { streaming: true },
    );
    expect('type' in result && result.type).toBe('stream');
    const head = (result as StreamRenderResult).head;
    expect(head.pprShell).toBe(true);
    expect(head.cacheTags).toEqual(['feed']);
    await (result as StreamRenderResult).stream.cancel();
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
  function makeLayout(dir: string, wrapperClass: string): LayoutEntry {
    return {
      filePath: '/fake/layout.tsx',
      dir,
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
      ['', makeLayout('', 'root-layout')],
    ]);
    const result = await renderRoute(makeRequest('/docs'), routes, layouts);
    expect('body' in result && result.body).toContain('root-layout');
    expect('body' in result && result.body).toContain('page content');
  });

  it('applies nested layouts outermost-first', async () => {
    const routes = makeRoute('/docs/guide');
    const layouts = new Map<string, LayoutEntry>([
      ['', makeLayout('', 'root-layout')],
      ['docs', makeLayout('docs', 'docs-layout')],
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
      ['', makeLayout('', 'root-layout')],
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
      ['', makeLayout('', 'root-layout')],
      ['docs', makeLayout('docs', 'docs-layout')],
    ]);
    const result = await renderRoute(makeRequest('/docs/guide'), routes, layouts);
    const body = 'body' in result ? result.body : '';
    const boundary = body.indexOf('id="__gio"');
    expect(body.indexOf('root-layout')).toBeLessThan(boundary);
    expect(body.indexOf('docs-layout')).toBeGreaterThan(boundary);
  });

  it('applies a layout inside a dynamic [id] folder to the pages beneath it', async () => {
    const routes = makeRoute('/posts/:id', {}, 'posts/[id]');
    const layouts = new Map<string, LayoutEntry>([
      ['', makeLayout('', 'root-layout')],
      ['posts/[id]', makeLayout('posts/[id]', 'post-layout')],
    ]);
    const body = bodyOf(await renderRoute(makeRequest('/posts/42'), routes, layouts));
    expect(body).toContain('post-layout');
    expect(body.indexOf('root-layout')).toBeLessThan(body.indexOf('post-layout'));
  });

  it("applies a (group) layout only to that group's pages", async () => {
    const layouts = new Map<string, LayoutEntry>([
      ['(shop)', makeLayout('(shop)', 'shop-layout')],
      ['(marketing)', makeLayout('(marketing)', 'marketing-layout')],
    ]);
    const routes = new Map([
      ...makeRoute('/cart', {}, '(shop)/cart'),
      ...makeRoute('/about', {}, '(marketing)/about'),
    ]);
    const cart = bodyOf(await renderRoute(makeRequest('/cart'), routes, layouts));
    expect(cart).toContain('shop-layout');
    expect(cart).not.toContain('marketing-layout');
    const about = bodyOf(await renderRoute(makeRequest('/about'), routes, layouts));
    expect(about).toContain('marketing-layout');
    expect(about).not.toContain('shop-layout');
  });

  it('associates layouts by folder, not URL prefix', async () => {
    // app/(feeds)/blog/rss/page.tsx serves /blog/rss but is not inside
    // app/blog/, so app/blog/layout.tsx must not wrap it.
    const routes = makeRoute('/blog/rss', {}, '(feeds)/blog/rss');
    const layouts = new Map<string, LayoutEntry>([['blog', makeLayout('blog', 'blog-layout')]]);
    const body = bodyOf(await renderRoute(makeRequest('/blog/rss'), routes, layouts));
    expect(body).toContain('page content');
    expect(body).not.toContain('blog-layout');
  });

  it('wraps root special pages in the root layout only, whatever the URL', async () => {
    const layouts = new Map<string, LayoutEntry>([
      ['', makeLayout('', 'root-layout')],
      ['docs', makeLayout('docs', 'docs-layout')],
    ]);
    const specialPages = {
      notFound: async () => ({
        default: function NotFound() {
          return React.createElement('h1', null, 'MISSING');
        },
      }),
    };
    const result = await renderRoute(
      makeRequest('/docs/missing'), new Map(), layouts, undefined, undefined, undefined, { specialPages },
    );
    expect('status' in result && result.status).toBe(404);
    const body = bodyOf(result);
    expect(body).toContain('MISSING');
    expect(body).toContain('root-layout');
    expect(body).not.toContain('docs-layout');
  });
});

// ─── Route matching ───────────────────────────────────────────────────────────

describe('route matching', () => {
  /** Pages that print their own pattern and params, registered in the given order. */
  function routesFor(patterns: string[]): Map<string, RouteModule> {
    const routes = new Map<string, RouteModule>();
    for (const pattern of patterns) {
      routes.set(pattern, {
        filePath: '/fake/page.tsx',
        urlPattern: pattern,
        dir: '',
        load: async () => ({
          default: function MatchedPage({ params }: Record<string, unknown>) {
            return React.createElement('p', null, `ROUTE ${pattern} PARAMS ${JSON.stringify(params)}`);
          },
        }),
      });
    }
    return routes;
  }

  async function resolve(patterns: string[], path: string): Promise<string> {
    const result = await renderRoute(makeRequest(path), routesFor(patterns), noLayouts);
    if (!('status' in result) || result.status === 404) return '404';
    // React escapes the JSON quotes in text content.
    return (/ROUTE (\S+) PARAMS (.*?)<\/p>/.exec(result.body)?.slice(1).join(' ') ?? '')
      .replace(/&quot;/g, '"');
  }

  it('matches a catch-all against one or more segments, keeping slashes', async () => {
    expect(await resolve(['/docs/*slug'], '/docs/a')).toBe('/docs/*slug {"slug":"a"}');
    expect(await resolve(['/docs/*slug'], '/docs/a/b/c')).toBe('/docs/*slug {"slug":"a/b/c"}');
  });

  it('never matches a required catch-all against its bare parent', async () => {
    expect(await resolve(['/docs/*slug'], '/docs')).toBe('404');
    expect(await resolve(['/docs/*slug'], '/docs/')).toBe('404');
  });

  it('matches an optional catch-all against the bare parent with an empty param', async () => {
    expect(await resolve(['/shop/*path?'], '/shop')).toBe('/shop/*path? {"path":""}');
    expect(await resolve(['/shop/*path?'], '/shop/')).toBe('/shop/*path? {"path":""}');
    expect(await resolve(['/shop/*path?'], '/shop/a/b')).toBe('/shop/*path? {"path":"a/b"}');
    expect(await resolve(['/*all?'], '/')).toBe('/*all? {"all":""}');
  });

  it('ranks static > dynamic > catch-all > optional catch-all regardless of registration order', async () => {
    const patterns = ['/blog/*any?', '/blog/*rest', '/blog/:id', '/blog/new'];
    for (const order of [patterns, [...patterns].reverse()]) {
      expect(await resolve(order, '/blog/new')).toBe('/blog/new {}');
      expect(await resolve(order, '/blog/42')).toBe('/blog/:id {"id":"42"}');
      expect(await resolve(order, '/blog/a/b')).toBe('/blog/*rest {"rest":"a/b"}');
      expect(await resolve(order, '/blog')).toBe('/blog/*any? {"any":""}');
    }
  });

  it('prefers a static page over an optional catch-all that matches nothing', async () => {
    for (const order of [['/shop', '/shop/*p?'], ['/shop/*p?', '/shop']]) {
      expect(await resolve(order, '/shop')).toBe('/shop {}');
      expect(await resolve(order, '/shop/x')).toBe('/shop/*p? {"p":"x"}');
    }
    // A deeper dynamic pattern beats an optional catch-all one level up.
    expect(await resolve(['/:a/*b?', '/:a/:b'], '/x/y')).toBe('/:a/:b {"a":"x","b":"y"}');
    expect(await resolve(['/:a/:b', '/:a/*b?'], '/x')).toBe('/:a/*b? {"a":"x","b":""}');
  });

  it('compares specificity segment by segment, left to right', async () => {
    for (const order of [['/:a/b', '/a/:b'], ['/a/:b', '/:a/b']]) {
      expect(await resolve(order, '/a/b')).toBe('/a/:b {"b":"b"}');
    }
  });

  it('never resolves a literal request for a dynamic pattern without params', async () => {
    expect(await resolve(['/posts/:id'], '/posts/:id')).toBe('/posts/:id {"id":":id"}');
  });

  it('matches route.ts handlers with catch-all patterns', async () => {
    const handlers = new Map<string, HandlerEntry>([
      ['/api/files/*key', {
        filePath: '/fake/route.ts',
        urlPattern: '/api/files/*key',
        methods: new Map<string, RouteHandlerFn>([['GET', req => ({ key: req.params['key'] })]]),
      }],
    ]);
    const result = await renderRoute(
      makeRequest('/api/files/a/b.txt'), new Map(), noLayouts, undefined, undefined, undefined, { handlers },
    );
    expect('body' in result && JSON.parse(result.body)).toEqual({ key: 'a/b.txt' });
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

  it('carries the image config the render used, so srcsets hydrate unchanged', async () => {
    const images = { widths: [640, 1080], quality: 80, unoptimized: false };
    const installed = installedImageConfig();
    let renderSaw: unknown;
    const routes = makeRoute('/', {
      default: function ImagePage() {
        renderSaw = (globalThis as Record<string, unknown>)['__GIO_IMAGES__'];
        return React.createElement('img', { alt: '' });
      },
    });
    installImageConfig(images);
    try {
      const result = await renderRoute(
        makeRequest('/'), routes, noLayouts, undefined, undefined, new Map([['/', '/e.js']]),
      );
      const body = 'body' in result ? result.body : '';
      expect(body).toContain('"images":{"widths":[640,1080],"quality":80,"unoptimized":false}');
      expect(renderSaw).toEqual(images);
    } finally {
      installImageConfig(installed);
    }
  });

  it('a static export (GIO_EXPORT=1) still hydrates with the manifest it is given', async () => {
    vi.stubEnv('GIO_EXPORT', '1');
    try {
      const result = await renderRoute(
        makeRequest('/'), makeRoute('/'), noLayouts, undefined, undefined, new Map([['/', '/e.js']]),
      );
      const body = 'body' in result ? result.body : '';
      expect(body).toContain('id="__gio_props"');
      expect(body).toContain('<script type="module" src="/e.js"');
    } finally {
      vi.unstubAllEnvs();
    }
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

  it('hands a rejected client bundle to the dev overlay, escaped', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    recordClientBuildError('/', 'route "/" imports server-only code: </script><b>x</b>');
    try {
      const result = await renderRoute(makeRequest('/'), makeRoute('/'), noLayouts);
      const body = 'body' in result ? result.body : '';
      expect(body).toContain('window.__GIO_SSR_ERROR__=');
      expect(body).toContain('imports server-only code: \\u003c/script>\\u003cb>x\\u003c/b>');
      expect(body).not.toContain('</script><b>');
      expect(body).toContain('page content');
    } finally {
      clearClientBuildErrors();
      vi.unstubAllEnvs();
    }
  });

  // Rust is in production mode unless NODE_ENV=development (an unset
  // NODE_ENV is the template's `npm start`): no overlay, so no diagnostics.
  it.each([undefined, 'production', 'test'])(
    'keeps build diagnostics out of the HTML when NODE_ENV is %s',
    async nodeEnv => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      recordClientBuildError('/', 'route "/" imports server-only code: lib/db.ts');
      try {
        const result = await renderRoute(makeRequest('/'), makeRoute('/'), noLayouts);
        const body = 'body' in result ? result.body : '';
        expect(body).toContain('page content');
        expect(body).not.toContain('__GIO_SSR_ERROR__');
        expect(body).not.toContain('lib/db.ts');
      } finally {
        clearClientBuildErrors();
        vi.unstubAllEnvs();
      }
    },
  );

  it('emits no overlay script when the route bundle built', async () => {
    recordClientBuildError('/other', 'unrelated failure');
    try {
      const clientScripts = new Map([['/', '/_next/static/chunks/route-index-ABC.js']]);
      const result = await renderRoute(
        makeRequest('/'), makeRoute('/'), noLayouts, undefined, undefined, clientScripts,
      );
      const body = 'body' in result ? result.body : '';
      expect(body).not.toContain('__GIO_SSR_ERROR__');
    } finally {
      clearClientBuildErrors();
    }
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
      ['', {
        filePath: '/fake/layout.tsx',
        dir: '',
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
      headers: { cookie: 'session=abc; theme=dark', 'content-type': 'application/json' },
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
    expect('setCookies' in result).toBe(false);
  });

  it('flags every handler response routeHandler (HTML too), but never a page', async () => {
    const html = '<!doctype html><p>from a handler</p>';
    const handlers = makeHandlers('/report', {
      GET: () => new Response(html, { headers: { 'content-type': 'text/html' } }),
      POST: () => ({ ok: true }),
      DELETE: () => undefined,
    });
    const routes = makeRoute('/report');
    const outcomes = await Promise.all(['GET', 'POST', 'DELETE'].map(method =>
      renderRoute({ ...makeRequest('/report'), method }, routes, noLayouts, undefined, undefined, undefined, {
        handlers,
      })));
    for (const result of outcomes) {
      expect('routeHandler' in result && result.routeHandler).toBe(true);
    }
    expect('body' in outcomes[0]! && outcomes[0].body).toBe(html);

    // A route.ts without GET leaves GET to its sibling page: no flag there.
    const postOnly = makeHandlers('/report', { POST: () => ({ ok: true }) });
    const page = await renderRoute(makeRequest('/report'), routes, noLayouts, undefined, undefined, undefined, {
      handlers: postOnly,
    });
    expect('body' in page && page.body).toContain('page content');
    expect('routeHandler' in page).toBe(false);
  });

  it('keeps every Set-Cookie of a Response as its own entry, verbatim', async () => {
    const headers = new Headers();
    headers.append('Set-Cookie', 'session=abc; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT');
    headers.append('Set-Cookie', 'csrf=xyz; Path=/; SameSite=Strict');
    const handlers = makeHandlers('/api/login', {
      POST: () => new Response('ok', { headers }),
    });
    const req = { ...makeRequest('/api/login'), method: 'POST' };
    const result = await renderRoute(req, new Map(), noLayouts, undefined, undefined, undefined, {
      handlers,
    });
    expect('setCookies' in result && result.setCookies).toEqual([
      'session=abc; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
      'csrf=xyz; Path=/; SameSite=Strict',
    ]);
    expect('headers' in result && result.headers['set-cookie']).toBeUndefined();
  });

  it('joins other repeated Response headers instead of dropping them', async () => {
    const headers = new Headers();
    headers.append('Link', '</a.css>; rel=preload; as=style');
    headers.append('Link', '</b.js>; rel=modulepreload');
    headers.append('WWW-Authenticate', 'Basic realm="a"');
    headers.append('WWW-Authenticate', 'Bearer realm="b"');
    const handlers = makeHandlers('/api/thing', {
      GET: () => new Response(null, { status: 401, headers }),
    });
    const result = await renderRoute(
      makeRequest('/api/thing'), new Map(), noLayouts, undefined, undefined, undefined, { handlers },
    );
    expect('headers' in result && result.headers['link']).toBe(
      '</a.css>; rel=preload; as=style, </b.js>; rel=modulepreload',
    );
    expect('headers' in result && result.headers['www-authenticate']).toBe(
      'Basic realm="a", Bearer realm="b"',
    );
  });

  it('keeps cookies on binary (base64) Response bodies', async () => {
    const headers = new Headers({ 'content-type': 'application/octet-stream' });
    headers.append('Set-Cookie', 'a=1');
    headers.append('Set-Cookie', 'b=2');
    const handlers = makeHandlers('/api/file', {
      GET: () => new Response(new Uint8Array([0xff, 0xfe, 0x00]), { headers }),
    });
    const result = await renderRoute(
      makeRequest('/api/file'), new Map(), noLayouts, undefined, undefined, undefined, { handlers },
    );
    expect('bodyBase64' in result && result.bodyBase64).toBe(true);
    expect('setCookies' in result && result.setCookies).toEqual(['a=1', 'b=2']);
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

  async function postJson(contentType: string | undefined, handler: RouteHandlerFn) {
    const handlers = makeHandlers('/api/json', { POST: handler });
    const req: IPCRequest = {
      ...makeRequest('/api/json'),
      method: 'POST',
      body: '{"a":1}',
      headers: contentType === undefined ? {} : { 'content-type': contentType },
    };
    const result = await renderRoute(req, new Map(), noLayouts, undefined, undefined, undefined, {
      handlers,
    });
    if (!('status' in result)) throw new Error('expected a buffered response');
    return result;
  }

  it('json() parses bodies declared as application/json or +json', async () => {
    for (const contentType of [
      'application/json',
      'application/json; charset=utf-8',
      'Application/JSON',
      'application/merge-patch+json',
      'application/vnd.api+json; charset=utf-8',
    ]) {
      const result = await postJson(contentType, req => req.json());
      expect(result.status, contentType).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ a: 1 });
    }
  });

  it('json() on a body not declared as JSON is a 415, not a 500', async () => {
    for (const contentType of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', 'text/json']) {
      const result = await postJson(contentType, req => req.json());
      expect(result.status, String(contentType)).toBe(415);
      expect(result.headers['content-type']).toContain('application/json');
      expect(JSON.parse(result.body)).toMatchObject({ error: 'Unsupported Media Type' });
    }
  });

  it('a handler can catch the 415 error and still read the raw body', async () => {
    const result = await postJson('text/plain', req => {
      try {
        return req.json();
      } catch (err) {
        if (!isUnsupportedMediaTypeError(err)) throw err;
        expect(err).toBeInstanceOf(UnsupportedMediaTypeError);
        expect(err.status).toBe(415);
        return { raw: req.body };
      }
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ raw: '{"a":1}' });
  });

  it('a handler-thrown UnsupportedMediaTypeError from another module copy maps to 415', async () => {
    // Route files load in their own module namespace: detection is by brand.
    const foreign = Object.assign(new Error('nope'), { __gioUnsupportedMediaType: true });
    const result = await postJson('application/json', () => {
      throw foreign;
    });
    expect(result.status).toBe(415);
  });
});

describe('isJsonContentType', () => {
  it('accepts JSON media types only', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType(' application/ld+json ;profile=x')).toBe(true);
    expect(isJsonContentType(undefined)).toBe(false);
    expect(isJsonContentType('')).toBe(false);
    expect(isJsonContentType('application/json-seq')).toBe(false);
    expect(isJsonContentType('text/plain; application/json')).toBe(false);
  });
});

// ─── pages vs route.ts handlers ───────────────────────────────────────────────

describe('page and route.ts precedence', () => {
  async function render(
    method: string,
    path: string,
    routes: Map<string, RouteModule>,
    handlers: Map<string, HandlerEntry>,
  ): Promise<{ status: number; body: string; allow: string | undefined }> {
    const result = await renderRoute(
      { ...makeRequest(path), method }, routes, noLayouts, undefined, undefined, undefined, { handlers },
    );
    if (!('status' in result)) throw new Error('expected a buffered response');
    return { status: result.status, body: result.body, allow: result.headers['allow'] };
  }

  const echoSlug: RouteHandlerFn = req => ({ handler: true, params: req.params });

  it('serves a static page over a dynamic route.ts that also matches it', async () => {
    const routes = makeRoute('/blog/about');
    const handlers = makeHandlers('/blog/:slug', { GET: echoSlug, POST: echoSlug });

    const page = await render('GET', '/blog/about', routes, handlers);
    expect(page.status).toBe(200);
    expect(page.body).toContain('page content');
    // The page owns the URL, so it answers mutations too - with a 405.
    const post = await render('POST', '/blog/about', routes, handlers);
    expect(post.status).toBe(405);
    expect(post.allow).toBe('GET, HEAD');
    // Other slugs still reach the handler.
    const other = await render('GET', '/blog/hello', routes, handlers);
    expect(JSON.parse(other.body)).toEqual({ handler: true, params: { slug: 'hello' } });
  });

  it('never lets a catch-all route.ts shadow the pages below it', async () => {
    const routes = makeRoute('/api/docs');
    const handlers = makeHandlers('/api/*p', { GET: echoSlug });
    expect((await render('GET', '/api/docs', routes, handlers)).body).toContain('page content');
    expect(JSON.parse((await render('GET', '/api/x/y', routes, handlers)).body)).toEqual({
      handler: true,
      params: { p: 'x/y' },
    });

    // An optional catch-all route.ts loses its bare parent to a static page.
    const shop = makeRoute('/shop');
    const shopHandlers = makeHandlers('/shop/*p?', { GET: echoSlug });
    expect((await render('GET', '/shop', shop, shopHandlers)).body).toContain('page content');
  });

  it('lets a more specific route.ts own its URL outright, without falling through', async () => {
    const routes = makeRoute('/blog/:slug', {}, 'blog/[slug]');
    const handlers = makeHandlers('/blog/feed', { POST: echoSlug });
    // Only a sibling page (same pattern) renders a GET the route.ts lacks.
    const get = await render('GET', '/blog/feed', routes, handlers);
    expect(get.status).toBe(405);
    expect(get.allow).toBe('POST');
    expect((await render('POST', '/blog/feed', routes, handlers)).status).toBe(200);
    expect((await render('GET', '/blog/hello', routes, handlers)).body).toContain('page content');
  });

  it('keeps the same-folder pairing: exported methods hit the route.ts, GET falls through', async () => {
    const routes = makeRoute('/contact');
    const handlers = makeHandlers('/contact', { POST: echoSlug });
    expect((await render('GET', '/contact', routes, handlers)).body).toContain('page content');
    expect((await render('HEAD', '/contact', routes, handlers)).status).toBe(200);
    expect(JSON.parse((await render('POST', '/contact', routes, handlers)).body)).toEqual({
      handler: true,
      params: {},
    });
    const put = await render('PUT', '/contact', routes, handlers);
    expect(put.status).toBe(405);
    // The URL serves the page's GET/HEAD and the route.ts's POST.
    expect(put.allow).toBe('GET, HEAD, POST');
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
    // Cookies travel in setCookies, never in the single-valued headers map.
    expect('setCookies' in result && result.setCookies).toEqual(['visited=1; Path=/']);
    expect('headers' in result && result.headers['set-cookie']).toBeUndefined();
    // Caching a per-request set-cookie would replay it to every visitor.
    expect('cacheable' in result && result.cacheable).toBe(false);
    expect('cacheMaxAge' in result && result.cacheMaxAge).toBe(0);
  });

  it('sends every cookie of a set-cookie array and joins other repeated headers', async () => {
    const routes = makeRoute('/', {
      revalidate: 60,
      getServerSideProps: async () => ({
        props: {},
        headers: {
          'Set-Cookie': [
            'session=abc; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
            'csrf=xyz; Path=/; SameSite=Strict',
          ],
          link: ['</a.css>; rel=preload; as=style', '</b.js>; rel=modulepreload'],
          'x-single': 'one',
        },
      }),
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('setCookies' in result && result.setCookies).toEqual([
      'session=abc; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
      'csrf=xyz; Path=/; SameSite=Strict',
    ]);
    expect('headers' in result && result.headers['link']).toBe(
      '</a.css>; rel=preload; as=style, </b.js>; rel=modulepreload',
    );
    expect('headers' in result && result.headers['x-single']).toBe('one');
    expect('cacheable' in result && result.cacheable).toBe(false);
  });

  it('carries cookies on the head frame of a streamed render', async () => {
    const routes = makeRoute('/', {
      getServerSideProps: async () => ({
        props: {},
        headers: { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] },
      }),
    });
    const result = await renderRoute(
      makeRequest('/'), routes, noLayouts, undefined, undefined, undefined, { streaming: true },
    );
    const streamed = expectStream(result);
    expect(streamed.head.setCookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(streamed.head.headers['set-cookie']).toBeUndefined();
  });

  it('sends cookies with a redirect, keeping the redirect destination authoritative', async () => {
    const routes = makeRoute('/logout', {
      getServerSideProps: async () => ({
        redirect: { destination: '/login', permanent: false },
        headers: {
          'set-cookie': ['session=; Max-Age=0; Path=/', 'csrf=; Max-Age=0; Path=/'],
          location: '/somewhere-else',
        },
      }),
    });
    const result = await renderRoute(makeRequest('/logout'), routes, noLayouts);
    expect('status' in result && result.status).toBe(302);
    expect('headers' in result && result.headers['location']).toBe('/login');
    expect('setCookies' in result && result.setCookies).toEqual([
      'session=; Max-Age=0; Path=/',
      'csrf=; Max-Age=0; Path=/',
    ]);
  });

  it('omits setCookies when no cookies are set', async () => {
    const routes = makeRoute('/', {
      getServerSideProps: async () => ({ props: {}, headers: { 'x-a': 'b' } }),
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('setCookies' in result).toBe(false);
  });

  it('keeps the page cacheable when the returned headers flatten to nothing', async () => {
    // Cookies set only sometimes: an empty array sends no header, so it must
    // not cost a revalidate page its cache entry.
    const routes = makeRoute('/', {
      revalidate: 60,
      getServerSideProps: async () => ({
        props: {},
        headers: { 'set-cookie': [] as string[], link: [] as string[] },
      }),
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('setCookies' in result).toBe(false);
    expect('cacheable' in result && result.cacheable).toBe(true);
    expect('cacheMaxAge' in result && result.cacheMaxAge).toBe(60);
  });

  it('lets an onResponse plugin add cookies next to the page ones', async () => {
    const registry = new NodePluginRegistry();
    registry.register({
      name: 'test', version: '0.0.0',
      onResponse: async (_req, res) => ({
        ...res,
        setCookies: [...(res.setCookies ?? []), 'plugin=1; Path=/'],
      }),
    });
    const routes = makeRoute('/', {
      getServerSideProps: async () => ({ props: {}, headers: { 'set-cookie': 'page=1; Path=/' } }),
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts, registry);
    expect('setCookies' in result && result.setCookies).toEqual([
      'page=1; Path=/',
      'plugin=1; Path=/',
    ]);
  });

  it('page cookies reach onResponse in setCookies, where a plugin strips them', async () => {
    let seenHeaderCookie: string | undefined = 'unset';
    const registry = new NodePluginRegistry();
    registry.register({
      name: 'strip', version: '0.0.0',
      onResponse: async (_req, res) => {
        seenHeaderCookie = res.headers['set-cookie'];
        return { ...res, setCookies: [] };
      },
    });
    const routes = makeRoute('/', {
      getServerSideProps: async () => ({ props: {}, headers: { 'set-cookie': 'page=1; Path=/' } }),
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts, registry);
    // Documented in docs/plugins.md: the headers map no longer carries them.
    expect(seenHeaderCookie).toBeUndefined();
    expect('setCookies' in result && result.setCookies).toEqual([]);
    expect('headers' in result && result.headers['set-cookie']).toBeUndefined();
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

  it('listing the header names counts as a read (ownKeys)', async () => {
    const reads: ((ctx: GsspContextLike) => unknown)[] = [
      ctx => Object.getOwnPropertyNames(ctx.headers).includes('cookie'),
      ctx => Reflect.ownKeys(ctx.headers).includes('authorization'),
      ctx => Object.keys(ctx.headers).length,
      ctx => {
        const names: string[] = [];
        for (const name in ctx.headers) names.push(name);
        return names.join(',');
      },
    ];
    for (const read of reads) {
      expect(await cacheFields(gsspRoute('/', read))).toEqual(PERSONAL);
    }
  });

  it('a read counts even when the request carries no credentials (the anonymous variant)', async () => {
    const routes = gsspRoute('/', ctx => ctx.cookies['session'] ?? 'anon');
    expect(await cacheFields(routes, makeRequest('/'))).toEqual(PERSONAL);
    // No cookie descriptor is ever touched here - the enumeration decides.
    const anonymous: ((ctx: GsspContextLike) => unknown)[] = [
      ctx => ({ ...ctx.headers })['cookie'] !== undefined ? 'IN' : 'ANON',
      ctx => Object.keys(ctx.headers).includes('cookie'),
      ctx => JSON.stringify(ctx.headers),
    ];
    for (const read of anonymous) {
      expect(await cacheFields(gsspRoute('/', read), makeRequest('/'))).toEqual(PERSONAL);
    }
  });

  it('a copy of the headers is a plain, cloneable object (and counts as a read)', async () => {
    const routes = gsspRoute('/', ctx => structuredClone({ ...ctx.headers })['x-thing']);
    const result = await renderRoute(credentialRequest(), routes, noLayouts);
    expect('body' in result && result.body).toContain('page content');
    expect('cacheable' in result && result.cacheable).toBe(false);
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

  it('plugin-set header names match regardless of case, and removals count too', async () => {
    const registry = new NodePluginRegistry();
    registry.register({
      name: 'auth',
      version: '1.0.0',
      onRequest: async (req) => {
        req.headers['X-User-Id'] = req.headers['cookie'] === 'session=u1' ? 'u1' : 'anon';
        if (req.headers['cookie'] === undefined) delete req.headers['x-thing'];
        return req;
      },
    });
    expect(
      await cacheFields(gsspRoute('/', ctx => ctx.headers['X-User-Id']), credentialRequest(), registry),
    ).toEqual(PERSONAL);
    expect(
      await cacheFields(gsspRoute('/', ctx => ctx.headers['x-user-id']), credentialRequest(), registry),
    ).toEqual(PERSONAL);
    expect(
      await cacheFields(gsspRoute('/', ctx => 'X-USER-ID' in ctx.headers), credentialRequest(), registry),
    ).toEqual(PERSONAL);
    const anonymous = { ...makeRequest('/'), headers: { 'x-thing': 'v' } };
    expect(
      await cacheFields(gsspRoute('/', ctx => ctx.headers['x-thing'] ?? 'gone'), anonymous, registry),
    ).toEqual(PERSONAL);
    // Untouched headers stay shareable.
    expect(
      await cacheFields(gsspRoute('/', ctx => ctx.headers['accept-language']), credentialRequest(), registry),
    ).toEqual(SHARED);
  });

  describe('an onRequest plugin that rewrites after reading credentials', () => {
    const page = (marker: string, overrides: Partial<PageModule> = {}): PageModule => ({
      revalidate: 60,
      default: () => React.createElement('main', null, marker),
      ...overrides,
    });
    const dashboards = (overrides: Partial<PageModule> = {}): Map<string, RouteModule> => {
      const routes = new Map<string, RouteModule>();
      for (const [pattern, marker] of [['/dash', 'PUBLIC_DASH'], ['/dash-admin', 'ADMIN_PANEL']] as const) {
        routes.set(pattern, {
          filePath: `/app${pattern}/page.tsx`,
          urlPattern: pattern,
          dir: pattern.slice(1),
          load: async () => page(marker, overrides),
        });
      }
      return routes;
    };
    const plugin = (onRequest: (req: IPCRequest) => IPCRequest): NodePluginRegistry => {
      const registry = new NodePluginRegistry();
      registry.register({ name: 'rewrite', version: '1.0.0', onRequest: async req => onRequest(req) });
      return registry;
    };
    const admin = (path = '/dash'): IPCRequest => ({ ...makeRequest(path), headers: { cookie: 'role=admin' } });
    const toAdmin = (req: IPCRequest): IPCRequest =>
      (req.headers['cookie'] ?? '').includes('role=admin') ? { ...req, path: '/dash-admin' } : req;

    it('a path picked from the cookie is not cached under the requested URL', async () => {
      const registry = plugin(toAdmin);
      const result = await renderRoute(admin(), dashboards(), noLayouts, registry);
      expect('body' in result && result.body).toContain('ADMIN_PANEL');
      expect(await cacheFields(dashboards(), admin(), registry)).toEqual(PERSONAL);
      // The anonymous variant the plugin left alone is shared as before.
      expect(await cacheFields(dashboards(), makeRequest('/dash'), registry)).toEqual(SHARED);
    });

    it('so are a query or locale picked from credentials, rewritten in place', async () => {
      const query = plugin(req => {
        if (req.headers['authorization'] !== undefined) req.query = { ...req.query, view: 'admin' };
        return req;
      });
      const authorized = { ...makeRequest('/dash'), headers: { authorization: 'Bearer t' } };
      expect(await cacheFields(dashboards(), authorized, query)).toEqual(PERSONAL);
      const locale = plugin(req => {
        req.locale = 'cookie' in req.headers ? 'fr' : req.locale;
        return req;
      });
      expect(await cacheFields(dashboards(), admin(), locale)).toEqual(PERSONAL);
    });

    it('rewrites that read no credentials, and credential reads that rewrite nothing, stay shared', async () => {
      const fixed = plugin(req => (req.path === '/dash' ? { ...req, path: '/dash-admin' } : req));
      expect(await cacheFields(dashboards(), admin(), fixed)).toEqual(SHARED);
      const byLanguage = plugin(req =>
        req.headers['accept-language'] === 'fr' ? { ...req, path: '/dash-admin' } : req,
      );
      const french = { ...admin(), headers: { cookie: 'role=admin', 'accept-language': 'fr' } };
      expect(await cacheFields(dashboards(), french, byLanguage)).toEqual(SHARED);
      const readsOnly = plugin(req => {
        req.headers['x-role'] = req.headers['cookie'] ?? 'anon';
        return req;
      });
      expect(await cacheFields(dashboards(), admin(), readsOnly)).toEqual(SHARED);
    });

    it('stores no PPR shell for such a rewrite either', async () => {
      const streamed = expectStream(
        await renderRoute(
          admin(), dashboards({ shell: 'cache' }), noLayouts, plugin(toAdmin), undefined, undefined, { streaming: true },
        ),
      );
      expect(streamed.head.pprShell).toBeUndefined();
      expect(streamed.head.cacheable).toBe(false);
    });
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

    /** Pump `streamed` like the IPC server: the text before shell_end (null without one) and all of it. */
    async function pumpShell(streamed: StreamRenderResult): Promise<{ shell: string | null; body: string }> {
      const written: Buffer[] = [];
      const sink = {
        destroyed: false,
        writableLength: 0,
        write(data: Buffer): boolean {
          written.push(data);
          return true;
        },
      };
      await pumpRenderStream(sink, 'r1', streamed);
      const frames: Record<string, unknown>[] = [];
      for (let wire = Buffer.concat(written); wire.length >= 4; wire = wire.subarray(4 + wire.readUInt32BE(0))) {
        frames.push(JSON.parse(wire.subarray(4, 4 + wire.readUInt32BE(0)).toString('utf8')) as Record<string, unknown>);
      }
      const text = (list: Record<string, unknown>[]): string =>
        list.filter(f => f['type'] === 'chunk').map(f => String(f['data'])).join('');
      const boundary = frames.findIndex(f => f['type'] === 'shell_end');
      return { shell: boundary === -1 ? null : text(frames.slice(0, boundary)), body: text(frames) };
    }

    /** The caching-layers docs page: `who` from the cookie, rendered by `hole` inside <Suspense>. */
    function storefront(
      hole: (props: { who: string }) => React.ReactNode,
      read: (ctx: GsspContextLike) => string = ctx => ctx.cookies['session'] ?? 'anon',
    ): Map<string, RouteModule> {
      return makeRoute('/', {
        revalidate: 60,
        shell: 'cache',
        getServerSideProps: async (ctx) => ({ props: { who: read(ctx as GsspContextLike) } }),
        default: function Storefront({ who }: Record<string, unknown>) {
          return React.createElement(
            'main',
            null,
            React.createElement('h1', null, 'STOREFRONT'),
            React.createElement(
              React.Suspense,
              { fallback: React.createElement('p', null, 'CART_LOADING') },
              React.createElement(hole, { who: String(who) }),
            ),
          );
        },
      });
    }

    it("never stores a shell holding a hole that rendered the visitor's props without suspending", async () => {
      const Cart = ({ who }: { who: string }): React.ReactNode => React.createElement('p', null, `CART:${who}`);
      const streamed = expectStream(
        await renderRoute(
          credentialRequest(), storefront(Cart), noLayouts, undefined, undefined, clientScripts, streamingExtras,
        ),
      );
      expect(streamed.head.pprShell).toBe(true);
      const { shell, body } = await pumpShell(streamed);
      // u1's cart is in the bytes before the boundary: no shell_end, so Rust stores nothing.
      expect(shell).toBeNull();
      expect(body).toContain('CART:u1');
    });

    it('stores the shell when the personalized hole suspends past it', async () => {
      const pending = new Map<string, { done: boolean; promise: Promise<void> }>();
      const SlowCart = ({ who }: { who: string }): React.ReactNode => {
        let gate = pending.get(who);
        if (gate === undefined) {
          const created = { done: false, promise: Promise.resolve() };
          created.promise = new Promise<void>(resolve => setTimeout(() => {
            created.done = true;
            resolve();
          }, 20));
          gate = created;
          pending.set(who, gate);
        }
        if (!gate.done) throw gate.promise;
        return React.createElement('p', null, `CART:${who}`);
      };
      const streamed = expectStream(
        await renderRoute(
          credentialRequest(), storefront(SlowCart), noLayouts, undefined, undefined, clientScripts, streamingExtras,
        ),
      );
      const { shell, body } = await pumpShell(streamed);
      expect(shell).toContain('STOREFRONT');
      expect(shell).toContain('CART_LOADING');
      expect(shell).not.toContain('u1');
      expect(body).toContain('CART:u1');
    });

    it('an app/loading.* around the page is not a hole: a suspending hole inside keeps the shell', async () => {
      const files = emptySegmentFiles();
      files.loading.set('', {
        kind: 'loading',
        dir: '',
        filePath: '/app/loading.tsx',
        load: async () => ({ default: () => React.createElement('p', null, 'APP_LOADING') }),
      });
      const extras = { ...streamingExtras, segmentFiles: files };
      const gate = new Promise<void>(resolve => setTimeout(resolve, 20));
      const SlowCart = ({ who }: { who: string }): React.ReactNode => {
        React.use(gate);
        return React.createElement('p', null, `CART:${who}`);
      };
      const slow = await pumpShell(expectStream(
        await renderRoute(credentialRequest(), storefront(SlowCart), noLayouts, undefined, undefined, clientScripts, extras),
      ));
      expect(slow.shell).toContain('STOREFRONT');
      expect(slow.shell).not.toContain('u1');
      // The page's own hole rendering inline is still caught inside the loading boundary.
      const Cart = ({ who }: { who: string }): React.ReactNode => React.createElement('p', null, `CART:${who}`);
      const inline = await pumpShell(expectStream(
        await renderRoute(credentialRequest(), storefront(Cart), noLayouts, undefined, undefined, clientScripts, extras),
      ));
      expect(inline.shell).toBeNull();
      expect(inline.body).toContain('CART:u1');
    });

    it('judges the shell bytes: inline or already-resolved holes, or no hole at all, are not stored', async () => {
      const Cart = ({ who }: { who: string }): React.ReactNode => React.createElement('p', null, who);
      const streamed = expectStream(
        await renderRoute(
          credentialRequest(), storefront(Cart), noLayouts, undefined, undefined, clientScripts, streamingExtras,
        ),
      );
      const pendingHole = '<main><!--$?--><template id="B:0"></template><p>CART_LOADING</p><!--/$--></main>';
      expect(streamed.keepShell?.(pendingHole)).toBe(true);
      // A hole whose content resolved before the boundary tick.
      expect(streamed.keepShell?.(`${pendingHole}<div hidden id="S:0"><p>u1</p></div>`)).toBe(false);
      expect(streamed.keepShell?.('<main><!--$--><p>u1</p><!--/$--></main>')).toBe(false);
      expect(streamed.keepShell?.('<main><p>u1</p></main>')).toBe(false);
    });

    it('a gSSP that reads no credentials keeps its shell, holes rendered inline included', async () => {
      const Cart = ({ who }: { who: string }): React.ReactNode => React.createElement('p', null, `CART:${who}`);
      const streamed = expectStream(
        await renderRoute(
          credentialRequest(),
          storefront(Cart, ctx => ctx.query['who'] ?? 'everyone'),
          noLayouts, undefined, undefined, clientScripts, streamingExtras,
        ),
      );
      const { shell } = await pumpShell(streamed);
      expect(shell).toContain('CART:everyone');
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

// ─── client identity (ip, scheme, host, requestId) ────────────────────────────

describe('client identity', () => {
  const identified = (path = '/'): IPCRequest => ({
    ...makeRequest(path),
    ip: '198.51.100.4',
    scheme: 'https',
    host: 'app.example',
    requestId: 'rid-123',
  });

  it('route handlers see ip, scheme, host and requestId', async () => {
    let seen: GioRequest | undefined;
    const handlers = makeHandlers('/api/who', {
      GET: (gioReq) => {
        seen = gioReq;
        return null;
      },
    });
    await renderRoute(identified('/api/who'), new Map(), noLayouts, undefined, undefined, undefined, {
      handlers,
    });
    expect(seen).toMatchObject({
      ip: '198.51.100.4',
      scheme: 'https',
      host: 'app.example',
      requestId: 'rid-123',
    });
  });

  it('the fields are absent when the server sent none (static export, older servers)', async () => {
    let seen: GioRequest | undefined;
    const handlers = makeHandlers('/api/who', {
      GET: (gioReq) => {
        seen = gioReq;
        return null;
      },
    });
    await renderRoute(makeRequest('/api/who'), new Map(), noLayouts, undefined, undefined, undefined, {
      handlers,
    });
    for (const key of ['ip', 'scheme', 'host', 'requestId']) {
      expect(seen).not.toHaveProperty(key);
    }
  });

  it('getServerSideProps sees them on ctx', async () => {
    let ctxSeen: Record<string, unknown> | undefined;
    const routes = makeRoute('/', {
      getServerSideProps: async (ctx) => {
        ctxSeen = { ip: ctx.ip, scheme: ctx.scheme, host: ctx.host, requestId: ctx.requestId };
        return { props: {} };
      },
    });
    await renderRoute(identified(), routes, noLayouts);
    expect(ctxSeen).toEqual({
      ip: '198.51.100.4',
      scheme: 'https',
      host: 'app.example',
      requestId: 'rid-123',
    });
  });

  describe('personal-render detection', () => {
    const PERSONAL = { cacheable: false, cacheMaxAge: 0 };
    const SHARED = { cacheable: true, cacheMaxAge: 60 };

    async function cacheFieldsFor(
      read: (ctx: GsspContext) => unknown,
      req: IPCRequest = identified(),
    ): Promise<{ cacheable: unknown; cacheMaxAge: unknown }> {
      const routes = makeRoute('/', {
        revalidate: 60,
        getServerSideProps: async (ctx) => ({ props: { v: String(read(ctx)) } }),
      });
      const result = await renderRoute(req, routes, noLayouts);
      return {
        cacheable: 'cacheable' in result ? result.cacheable : undefined,
        cacheMaxAge: 'cacheMaxAge' in result ? result.cacheMaxAge : undefined,
      };
    }

    it('reading ctx.ip makes the render personal - an IP-dependent page is never shared', async () => {
      expect(await cacheFieldsFor(ctx => ctx.ip)).toEqual(PERSONAL);
      // Even without an address (the anonymous variant), the read decides.
      expect(await cacheFieldsFor(ctx => ctx.ip ?? 'none', makeRequest('/'))).toEqual(PERSONAL);
    });

    it('reading raw client-address headers is just as personal', async () => {
      const req = { ...identified(), headers: { 'x-forwarded-for': '1.2.3.4', forwarded: 'for=1.2.3.4' } };
      for (const name of ['x-forwarded-for', 'X-Forwarded-For', 'forwarded', 'x-real-ip']) {
        expect(await cacheFieldsFor(ctx => ctx.headers[name], req)).toEqual(PERSONAL);
      }
    });

    it('reading requestId keeps the page cacheable', async () => {
      expect(await cacheFieldsFor(ctx => ctx.requestId)).toEqual(SHARED);
    });

    it('reading ctx.host or ctx.scheme makes the render personal - the host is client-supplied', async () => {
      // Shared, `Host: evil.example` would put the attacker's host in every
      // visitor's cached links (cache poisoning).
      expect(await cacheFieldsFor(ctx => `${ctx.scheme}://${ctx.host}/reset`)).toEqual(PERSONAL);
      expect(await cacheFieldsFor(ctx => ctx.host)).toEqual(PERSONAL);
      expect(await cacheFieldsFor(ctx => ctx.scheme)).toEqual(PERSONAL);
      expect(await cacheFieldsFor(ctx => ctx.host ?? 'none', makeRequest('/'))).toEqual(PERSONAL);
    });

    it('reading the raw host headers is just as personal', async () => {
      const req = {
        ...identified(),
        headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' },
      };
      for (const name of ['host', 'Host', 'x-forwarded-host', 'x-forwarded-proto']) {
        expect(await cacheFieldsFor(ctx => ctx.headers[name], req)).toEqual(PERSONAL);
      }
    });
  });

  it('error frames echo the request id', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const logs = captureLogs();
    let result;
    try {
      const routes = makeRoute('/', {
        getServerSideProps: async () => { throw new Error('boom'); },
      });
      result = await renderRoute(identified(), routes, noLayouts);
    } finally {
      logs.restore();
      vi.unstubAllEnvs();
    }
    expect(result).toMatchObject({ error: true, requestId: 'rid-123' });
  });
});

// ─── response header flattening ───────────────────────────────────────────────

describe('flattenResponseHeaders', () => {
  it('lowercases names and merges case variants of one header', () => {
    const { headers, setCookies } = flattenResponseHeaders({
      Vary: 'accept',
      vary: ['accept-language'],
      'SET-COOKIE': 'a=1',
      'set-cookie': ['b=2'],
    });
    expect(headers).toEqual({ vary: 'accept, accept-language' });
    expect(setCookies).toEqual(['a=1', 'b=2']);
  });

  it('drops empty arrays instead of sending an empty header', () => {
    const { headers, setCookies } = flattenResponseHeaders({ link: [], 'set-cookie': [] });
    expect(headers).toEqual({});
    expect(setCookies).toEqual([]);
  });
});

// ─── CSP nonces ───────────────────────────────────────────────────────────────

describe('CSP nonce placeholder', () => {
  const PLACEHOLDER = '0123456789abcdef0123456789abcdef';
  const clientScripts = new Map([['/', '/_next/static/chunks/route-index-ABC.js']]);

  beforeEach(() => {
    process.env.GIO_CSP_NONCE_PLACEHOLDER = PLACEHOLDER;
  });
  afterEach(() => {
    delete process.env.GIO_CSP_NONCE_PLACEHOLDER;
    delete process.env.GIO_EXPORT;
  });

  /** Opening tags of every executable script (JSON data blocks excluded). */
  function executableScriptTags(html: string): string[] {
    return [...html.matchAll(/<script\b[^>]*>/g)]
      .map(m => m[0])
      .filter(tag => !tag.includes('type="application/json"'));
  }

  /** A page whose Suspense boundary resolves after the shell flushed. */
  function suspendingRoute(): Map<string, RouteModule> {
    let resolve: (() => void) | undefined;
    const ready = new Promise<void>(r => { resolve = r; });
    setTimeout(() => resolve?.(), 20);
    function Late(): React.ReactElement {
      React.use(ready);
      return React.createElement('p', null, 'LATE_CONTENT');
    }
    return makeRoute('/', {
      default: function Page() {
        return React.createElement(
          React.Suspense,
          { fallback: React.createElement('p', null, 'loading') },
          React.createElement(Late),
        );
      },
    });
  }

  it('cspNonce() returns the placeholder only when it is well-formed and not exporting', () => {
    expect(cspNonce()).toBe(PLACEHOLDER);
    process.env.GIO_CSP_NONCE_PLACEHOLDER = 'not-a-placeholder';
    expect(cspNonce()).toBeUndefined();
    process.env.GIO_CSP_NONCE_PLACEHOLDER = PLACEHOLDER;
    process.env.GIO_EXPORT = '1';
    expect(cspNonce()).toBeUndefined();
    delete process.env.GIO_CSP_NONCE_PLACEHOLDER;
    delete process.env.GIO_EXPORT;
    expect(cspNonce()).toBeUndefined();
  });

  it('every inline and bootstrap script of a buffered render carries the placeholder', async () => {
    const result = await renderRoute(
      makeRequest('/'), makeRoute('/', { revalidate: 60 }), noLayouts, undefined, undefined, clientScripts,
    );
    const html = bodyOf(result);
    const tags = executableScriptTags(html);
    expect(tags.some(tag => tag.includes('route-index-ABC.js'))).toBe(true);
    expect(tags.length).toBeGreaterThanOrEqual(2); // bootstrap module + observer
    for (const tag of tags) expect(tag).toContain(`nonce="${PLACEHOLDER}"`);
  });

  it("streamed renders nonce React's Suspense runtime scripts too", async () => {
    const result = await renderRoute(
      makeRequest('/'), suspendingRoute(), noLayouts, undefined, undefined, clientScripts, { streaming: true },
    );
    const streamed = expectStream(result);
    const html = streamed.prefix + (await readStreamToString(streamed.stream)) + streamed.suffix;
    expect(html).toContain('LATE_CONTENT');
    const tags = executableScriptTags(html);
    // bootstrap module, React's reveal script(s), and the document observer
    expect(tags.length).toBeGreaterThanOrEqual(3);
    for (const tag of tags) expect(tag).toContain(`nonce="${PLACEHOLDER}"`);
  });

  it('PPR shell and holes renders use the same placeholder', async () => {
    const routes = makeRoute('/', { shell: 'cache', revalidate: 60 });
    const shell = expectStream(await renderRoute(
      makeRequest('/'), routes, noLayouts, undefined, undefined, clientScripts, { streaming: true },
    ));
    const holes = expectStream(await renderRoute(
      { ...makeRequest('/'), skipShell: true }, routes, noLayouts, undefined, undefined, clientScripts, { streaming: true },
    ));
    const shellHtml = shell.prefix + (await readStreamToString(shell.stream)) + shell.suffix;
    const holesHtml = await readStreamToString(holes.stream);
    for (const tag of executableScriptTags(shellHtml + holesHtml + holes.suffix)) {
      expect(tag).toContain(`nonce="${PLACEHOLDER}"`);
    }
  });

  it('the built-in 404 nonces its inline style', async () => {
    const result = await renderRoute(makeRequest('/nope'), new Map(), noLayouts);
    expect(bodyOf(result)).toContain(`<style nonce="${PLACEHOLDER}">`);
  });

  it('renders no nonce attributes at all without the placeholder', async () => {
    delete process.env.GIO_CSP_NONCE_PLACEHOLDER;
    const result = await renderRoute(
      makeRequest('/'), makeRoute('/', { revalidate: 60 }), noLayouts, undefined, undefined, clientScripts,
    );
    expect(bodyOf(result)).not.toContain('nonce=');
    const missing = await renderRoute(makeRequest('/nope'), new Map(), noLayouts);
    expect(bodyOf(missing)).not.toContain('nonce=');
  });
});

/**
 * giojs-core/src/ssr-metadata.test.ts
 *
 * Head metadata through the real render pipeline: tags hoisted into the
 * root layout's <head> (buffered and streamed), the document prefix when
 * there is no root layout, the envelope copy the client renders, what
 * generateMetadata receives, credential reads making the render personal
 * (PPR included - the head is part of the shell), duplicate titles, and
 * special pages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderRoute, type StreamRenderResult } from './ssr.ts';
import { notFound } from './not-found.ts';
import type { IPCRequest } from './context.ts';
import {
  emptySegmentFiles,
  type GsspContext,
  type LayoutEntry,
  type LayoutModule,
  type PageModule,
  type RouteModule,
  type SegmentFileKind,
  type SegmentFiles,
} from './router.ts';
import type { Metadata, MetadataExtras } from './metadata.ts';

function makeRequest(path: string, headers: Record<string, string> = {}): IPCRequest {
  return {
    id: 'meta',
    method: 'GET',
    path,
    params: {},
    query: {},
    headers,
    body: null,
    bodyBase64: false,
    deploymentId: 'test',
    locale: 'en',
  };
}

function route(pattern: string, page: Partial<PageModule>, dir = pattern.slice(1)): Map<string, RouteModule> {
  const mod: PageModule = {
    default: () => React.createElement('main', null, 'PAGE_BODY'),
    ...page,
  };
  return new Map([[pattern, { filePath: '/app/page.tsx', urlPattern: pattern, dir, load: async () => mod }]]);
}

function layoutEntry(dir: string, mod: LayoutModule): [string, LayoutEntry] {
  return [dir, { filePath: `/app/${dir}/layout.tsx`, dir, load: async () => mod }];
}

/** Root layout rendering the document, optionally with a hand-written <title>. */
function rootLayout(metadata?: Metadata, handTitle?: string): [string, LayoutEntry] {
  return layoutEntry('', {
    default: ({ children }) =>
      React.createElement(
        'html',
        { lang: 'en' },
        React.createElement(
          'head',
          null,
          React.createElement('meta', { charSet: 'utf-8' }),
          handTitle !== undefined ? React.createElement('title', null, handTitle) : null,
        ),
        React.createElement('body', null, children),
      ),
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

/** A not-found.* or error.* file in `dir` rendering `marker`. */
function segmentFile(files: SegmentFiles, kind: SegmentFileKind, dir: string, marker: string): void {
  const map = kind === 'not-found' ? files.notFound : kind === 'error' ? files.error : files.loading;
  map.set(dir, {
    kind,
    dir,
    filePath: `/app/${dir}/${kind}.tsx`,
    load: async () => ({ default: () => React.createElement('h1', null, marker) }),
  });
}

function headOf(html: string): string {
  const end = html.indexOf('</head>');
  expect(end).toBeGreaterThan(-1);
  return html.slice(0, end);
}

function bodyOf(result: Awaited<ReturnType<typeof renderRoute>>): string {
  if (!('body' in result) || typeof result.body !== 'string') throw new Error('expected a buffered render');
  return result.body;
}

async function readStream(result: Awaited<ReturnType<typeof renderRoute>>): Promise<string> {
  if (!('type' in result) || result.type !== 'stream') throw new Error('expected a stream');
  const streamed = result as StreamRenderResult;
  return streamed.prefix + (await new Response(streamed.stream).text()) + streamed.suffix;
}

function envelopeOf(html: string): Record<string, unknown> {
  const json = html.match(/<script id="__gio_props" type="application\/json">([^<]*)<\/script>/)?.[1];
  expect(json).toBeDefined();
  return JSON.parse(json!) as Record<string, unknown>;
}

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

const clientScripts = new Map([['/posts/:id', '/e.js'], ['/', '/home.js']]);

describe('metadata in the rendered document', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hoists the merged tags into the root layout <head> and copies them into the envelope', async () => {
    const layouts = new Map([
      rootLayout({ title: { default: 'Acme', template: '%s | Acme' }, description: 'Acme site' }),
      layoutEntry('blog', {
        default: ({ children }) => React.createElement('section', null, children),
        metadata: { openGraph: { siteName: 'Acme Blog' } },
      }),
    ]);
    const routes = route('/posts/:id', { metadata: { title: 'Hello' } }, 'blog/posts/[id]');
    const html = bodyOf(
      await renderRoute(makeRequest('/posts/1'), routes, layouts, undefined, undefined, clientScripts),
    );
    const head = headOf(html);
    expect(head).toContain('<title>Hello | Acme</title>');
    expect(head).toContain('<meta name="description" content="Acme site"/>');
    expect(head).toContain('<meta property="og:site_name" content="Acme Blog"/>');
    // Nothing of it is left inside the hydration boundary.
    expect(html.slice(html.indexOf('<div id="__gio">'))).not.toContain('<title');
    expect(envelopeOf(html)['metadata']).toEqual([
      { tag: 'title', text: 'Hello | Acme' },
      { tag: 'meta', attrs: { name: 'description', content: 'Acme site' } },
      { tag: 'meta', attrs: { property: 'og:site_name', content: 'Acme Blog' } },
    ]);
  });

  it('pages without metadata render exactly as before (no envelope field)', async () => {
    const html = bodyOf(
      await renderRoute(makeRequest('/'), route('/', {}), new Map([rootLayout()]), undefined, undefined, clientScripts),
    );
    expect(envelopeOf(html)['metadata']).toBeUndefined();
    expect(headOf(html)).not.toContain('<title');
  });

  it('streamed renders put the tags in the shell <head>, ahead of Suspense content', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let ready = false;
    function Slow(): React.ReactElement {
      if (!ready) {
        throw gate.then(() => {
          ready = true;
        });
      }
      return React.createElement('p', null, 'SLOW_CONTENT');
    }
    const routes = route('/', {
      metadata: { title: 'Streamed', description: 'from the shell' },
      default: () =>
        React.createElement(React.Suspense, { fallback: React.createElement('p', null, 'LOADING') }, React.createElement(Slow)),
    });
    const result = await renderRoute(
      makeRequest('/'),
      routes,
      new Map([rootLayout(undefined, 'Hand')]),
      undefined,
      undefined,
      clientScripts,
      { streaming: true },
    );
    const streamed = result as StreamRenderResult;
    expect(streamed.type).toBe('stream');
    const reader = streamed.stream.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    // The first flush (the shell) already carries the head with the tags,
    // and the hand-written title is gone.
    expect(headOf(first)).toContain('<title>Streamed</title>');
    expect(headOf(first)).toContain('<meta name="description" content="from the shell"/>');
    expect(first).not.toContain('Hand');
    expect(first).not.toContain('SLOW_CONTENT');
    release();
    let rest = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(rest).toContain('SLOW_CONTENT');
  });

  it('without a root layout the tags go into the document prefix head', async () => {
    const routes = route('/', { metadata: { title: 'Bare', robots: { index: false } } });
    const html = bodyOf(await renderRoute(makeRequest('/'), routes, new Map(), undefined, undefined, clientScripts));
    expect(headOf(html)).toContain('<title>Bare</title><meta name="robots" content="noindex"/>');
    expect(html.indexOf('<title')).toBe(html.lastIndexOf('<title'));
    expect(envelopeOf(html)['metadata']).toEqual([
      { tag: 'title', text: 'Bare' },
      { tag: 'meta', attrs: { name: 'robots', content: 'noindex' } },
    ]);

    const streamed = await readStream(
      await renderRoute(makeRequest('/'), routes, new Map(), undefined, undefined, clientScripts, {
        streaming: true,
      }),
    );
    expect(headOf(streamed)).toContain('<title>Bare</title>');
    expect(streamed.indexOf('<title')).toBe(streamed.lastIndexOf('<title'));
  });

  it('escapes hostile metadata values', async () => {
    const routes = route('/', {
      generateMetadata: async () => ({ title: '</title><script>alert(1)</script>', description: '"><x>' }),
    });
    for (const layouts of [new Map([rootLayout()]), new Map<string, LayoutEntry>()]) {
      const html = bodyOf(await renderRoute(makeRequest('/'), routes, layouts, undefined, undefined, clientScripts));
      expect(html).not.toContain('<script>alert(1)');
      expect(html).not.toContain('"><x>');
      expect(headOf(html)).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    }
  });

  it('warns (in dev only) when a layout still hand-writes a <title>', async () => {
    const routes = route('/', { metadata: { title: 'Meta' } });
    const layouts = new Map([rootLayout(undefined, 'Hand')]);
    for (const mode of ['production', 'development']) {
      vi.stubEnv('NODE_ENV', mode);
      const logs = captureLogs();
      let html: string;
      try {
        html = bodyOf(await renderRoute(makeRequest('/'), routes, layouts));
      } finally {
        logs.restore();
      }
      expect(headOf(html)).toContain('<title>Meta</title>');
      expect(html).not.toContain('Hand');
      const warned = logs.lines().some(l => String(l['msg']).includes('next to a metadata title'));
      expect(warned).toBe(mode === 'development');
    }
  });

  it('a <title> the page renders itself is superseded too, and the dev warning names pages', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const routes = route('/titled', {
      default: () =>
        React.createElement(
          React.Fragment,
          null,
          React.createElement('title', null, 'Page Title'),
          React.createElement('main', null, 'PAGE_BODY'),
        ),
    });
    const layouts = new Map([rootLayout({ title: { default: 'Site', template: '%s | Site' } })]);
    const logs = captureLogs();
    let html: string;
    try {
      html = bodyOf(await renderRoute(makeRequest('/titled'), routes, layouts));
    } finally {
      logs.restore();
    }
    expect(headOf(html)).toContain('<title>Site</title>');
    expect(html).not.toContain('Page Title');
    const warning = logs.lines().find(l => String(l['msg']).includes('next to a metadata title'));
    expect(String(warning?.['msg'])).toContain('a layout or page');
  });

  it('keeps a hand-written title when no metadata title resolves', async () => {
    const html = bodyOf(
      await renderRoute(makeRequest('/'), route('/', { metadata: { description: 'd' } }), new Map([rootLayout(undefined, 'Hand')])),
    );
    expect(headOf(html)).toContain('<title>Hand</title>');
  });
});

describe('generateMetadata', () => {
  it('receives the gSSP context (params included) and the page props; layouts get ctx only', async () => {
    const gssp = vi.fn(async (ctx: GsspContext) => ({ props: { post: { title: `Post ${ctx.params['id']}` } } }));
    const pageGenerate = vi.fn(async (ctx: GsspContext, extras: MetadataExtras) => {
      const post = extras.props?.['post'] as { title: string };
      return { title: post.title, alternates: { canonical: `/posts/${ctx.params['id']}` } };
    });
    const layoutGenerate = vi.fn(async (_ctx: GsspContext, extras: MetadataExtras) => {
      expect(extras).toEqual({});
      return { metadataBase: 'https://example.com' };
    });
    const layouts = new Map([
      rootLayout(),
      layoutEntry('posts', {
        default: ({ children }) => React.createElement(React.Fragment, null, children),
        generateMetadata: layoutGenerate,
      }),
    ]);
    const routes = route(
      '/posts/:id',
      { getServerSideProps: gssp, generateMetadata: pageGenerate },
      'posts/[id]',
    );
    const req = { ...makeRequest('/posts/9'), params: {} };
    const html = bodyOf(await renderRoute(req, routes, layouts));
    expect(gssp).toHaveBeenCalledTimes(1);
    expect(pageGenerate).toHaveBeenCalledTimes(1);
    expect(pageGenerate.mock.calls[0]?.[0].params).toEqual({ id: '9' });
    expect(pageGenerate.mock.calls[0]?.[1]).toEqual({ props: { post: { title: 'Post 9' } } });
    expect(layoutGenerate).toHaveBeenCalledTimes(1);
    expect(headOf(html)).toContain('<title>Post 9</title>');
    expect(headOf(html)).toContain('<link rel="canonical" href="https://example.com/posts/9"/>');
  });

  it('pages without gSSP get { params, searchParams } as props', async () => {
    const generate = vi.fn(async (_ctx: GsspContext, _extras: MetadataExtras) => ({ title: 'x' }));
    const routes = route('/posts/:id', { generateMetadata: generate }, 'posts/[id]');
    await renderRoute({ ...makeRequest('/posts/3'), query: { q: 'a' } }, routes, new Map());
    expect(generate.mock.calls[0]?.[1]).toEqual({ props: { params: { id: '3' }, searchParams: { q: 'a' } } });
  });

  it('notFound() in generateMetadata answers 404', async () => {
    const routes = route('/', {
      generateMetadata: async () => notFound(),
    });
    const result = await renderRoute(makeRequest('/'), routes, new Map());
    expect('status' in result && result.status).toBe(404);
  });

  it('a throwing generateMetadata answers 500', async () => {
    const logs = captureLogs();
    try {
      const routes = route('/', {
        generateMetadata: async () => {
          throw new Error('cms down');
        },
      });
      const result = await renderRoute(makeRequest('/'), routes, new Map());
      expect('error' in result && result.error).toBe(true);
    } finally {
      logs.restore();
    }
  });
});

describe('generateMetadata personal-read detection', () => {
  const credentialHeaders = { cookie: 'session=u1', authorization: 'Bearer t' };

  async function cacheFields(page: Partial<PageModule>, extras = {}, pattern = '/'): Promise<{
    cacheable: boolean;
    cacheMaxAge: number;
    pprShell: boolean;
    logs: Record<string, unknown>[];
  }> {
    const logs = captureLogs();
    try {
      const result = await renderRoute(
        makeRequest(pattern, credentialHeaders),
        route(pattern, { revalidate: 60, ...page }),
        new Map(),
        undefined,
        undefined,
        clientScripts,
        extras,
      );
      const head = 'type' in result && result.type === 'stream' ? result.head : result;
      if (!('cacheable' in head)) throw new Error('unexpected result');
      return {
        cacheable: head.cacheable,
        cacheMaxAge: head.cacheMaxAge,
        pprShell: head.pprShell === true,
        logs: logs.lines(),
      };
    } finally {
      logs.restore();
    }
  }

  it('reading only params keeps a revalidate page cacheable', async () => {
    const fields = await cacheFields({ generateMetadata: async ctx => ({ title: ctx.path }) });
    expect(fields).toMatchObject({ cacheable: true, cacheMaxAge: 60 });
  });

  for (const [what, read] of [
    ['cookies', (ctx: GsspContext) => ctx.cookies['session']],
    ['the authorization header', (ctx: GsspContext) => ctx.headers['authorization']],
    ['ctx.host', (ctx: GsspContext) => ctx.host],
    ['ctx.ip', (ctx: GsspContext) => ctx.ip],
  ] as const) {
    it(`reading ${what} makes the render personal`, async () => {
      const fields = await cacheFields({
        generateMetadata: async ctx => ({ title: String(read(ctx)) }),
      });
      expect(fields).toMatchObject({ cacheable: false, cacheMaxAge: 0 });
    });
  }

  it('explains why, once per route', async () => {
    const page = { generateMetadata: async (ctx: GsspContext) => ({ title: ctx.cookies['s'] ?? '' }) };
    const first = await cacheFields(page, {}, '/explained');
    const warned = (logs: Record<string, unknown>[]): boolean =>
      logs.some(l => String(l['msg']).startsWith('generateMetadata read request credentials'));
    expect(warned(first.logs)).toBe(true);
    expect(warned((await cacheFields(page, {}, '/explained')).logs)).toBe(false);
  });

  it("a layout's generateMetadata counts too", async () => {
    const logs = captureLogs();
    try {
      const layouts = new Map([
        layoutEntry('', {
          default: ({ children }) => React.createElement(React.Fragment, null, children),
          generateMetadata: async ctx => ({ title: ctx.cookies['session'] ?? 'anon' }),
        }),
      ]);
      const result = await renderRoute(
        makeRequest('/', credentialHeaders),
        route('/', { revalidate: 60 }),
        layouts,
      );
      expect('cacheable' in result && result.cacheable).toBe(false);
    } finally {
      logs.restore();
    }
  });

  it("under PPR it costs the shell its cache (the head is part of the shell), unlike gSSP's reads", async () => {
    const personal = await cacheFields(
      { shell: 'cache', generateMetadata: async ctx => ({ title: ctx.cookies['session'] ?? '' }) },
      { streaming: true },
    );
    expect(personal).toMatchObject({ cacheable: false, pprShell: false });
    const gsspOnly = await cacheFields(
      {
        shell: 'cache',
        getServerSideProps: async ctx => ({ props: { v: ctx.cookies['session'] } }),
        generateMetadata: async () => ({ title: 'shared' }),
      },
      { streaming: true },
    );
    expect(gsspOnly).toMatchObject({ cacheable: true, pprShell: true });
  });

  it('under PPR, generateMetadata using the props of a gSSP that read credentials costs the shell its cache', async () => {
    // gSSP may read cookies under PPR (its props stream after the shell),
    // but a title built from those props lands in the shell's <head>.
    const personal = await cacheFields(
      {
        shell: 'cache',
        getServerSideProps: async ctx => ({ props: { user: ctx.cookies['session'] ?? 'anon' } }),
        generateMetadata: async (_ctx, { props }) => ({ title: `Inbox of ${String(props?.['user'])}` }),
      },
      { streaming: true },
      '/inbox',
    );
    expect(personal).toMatchObject({ cacheable: false, cacheMaxAge: 0, pprShell: false });
    expect(personal.logs.some(l => String(l['msg']).startsWith('generateMetadata used the props'))).toBe(true);

    // Props from a gSSP that read nothing personal keep the shell cacheable.
    const shared = await cacheFields(
      {
        shell: 'cache',
        getServerSideProps: async ctx => ({ props: { slug: ctx.path } }),
        generateMetadata: async (_ctx, { props }) => ({ title: String(props?.['slug']) }),
      },
      { streaming: true },
      '/shared',
    );
    expect(shared).toMatchObject({ cacheable: true, cacheMaxAge: 60, pprShell: true });
  });

  it('the shell that would have been stored never carries the personal title', async () => {
    const logs = captureLogs();
    try {
      const result = await renderRoute(
        makeRequest('/inbox-shell', credentialHeaders),
        route('/inbox-shell', {
          revalidate: 60,
          shell: 'cache',
          getServerSideProps: async ctx => ({ props: { user: ctx.cookies['session'] } }),
          generateMetadata: async (_ctx, { props }) => ({ title: `Inbox of ${String(props?.['user'])}` }),
        }),
        new Map([rootLayout()]),
        undefined,
        undefined,
        clientScripts,
        { streaming: true },
      );
      const streamed = result as StreamRenderResult;
      expect(streamed.type).toBe('stream');
      // Plain streaming: no shell boundary for Rust to cut and store.
      expect(streamed.shellBoundary).toBeUndefined();
      expect(streamed.head.pprShell).toBeUndefined();
      expect(headOf(await readStream(result))).toContain('<title>Inbox of u1</title>');
    } finally {
      logs.restore();
    }
  });
});

describe('special pages', () => {
  it('a not-found page gets its own and its layouts\' metadata', async () => {
    const layouts = new Map([rootLayout({ title: { default: 'Acme', template: '%s | Acme' } }, 'Hand')]);
    const result = await renderRoute(makeRequest('/missing'), new Map(), layouts, undefined, undefined, undefined, {
      specialPages: {
        notFound: async () => ({
          default: () => React.createElement('h1', null, 'NOPE'),
          metadata: { title: 'Not found', robots: 'noindex' },
        }),
      },
    });
    expect('status' in result && result.status).toBe(404);
    const head = headOf(bodyOf(result));
    expect(head).toContain('<title>Not found | Acme</title>');
    expect(head).toContain('<meta name="robots" content="noindex"/>');
    expect(head).not.toContain('Hand');
  });

  /** app/blog/[slug]/layout.tsx titling itself from its route param. */
  function slugLayouts(seen: Array<Record<string, string>>): Map<string, LayoutEntry> {
    return new Map([
      rootLayout(),
      layoutEntry('blog/[slug]', {
        default: ({ children }) => React.createElement('article', null, children),
        generateMetadata: async ctx => {
          seen.push(ctx.params);
          return { title: ctx.params['slug']!.toUpperCase() };
        },
      }),
    ]);
  }

  it("a segment not-found renders with the matched params in its layouts' generateMetadata", async () => {
    const seen: Array<Record<string, string>> = [];
    const files = emptySegmentFiles();
    segmentFile(files, 'not-found', 'blog/[slug]', 'SLUG_404');
    const routes = route('/blog/:slug', { getServerSideProps: async () => ({ notFound: true }) }, 'blog/[slug]');
    const result = await renderRoute(
      makeRequest('/blog/hello'),
      routes,
      slugLayouts(seen),
      undefined,
      undefined,
      undefined,
      { segmentFiles: files },
    );
    expect('status' in result && result.status).toBe(404);
    const html = bodyOf(result);
    expect(html).toContain('SLUG_404');
    expect(headOf(html)).toContain('<title>HELLO</title>');
    expect(seen).toEqual([{ slug: 'hello' }]);
  });

  it("a segment error page renders with the matched params in its layouts' generateMetadata", async () => {
    const seen: Array<Record<string, string>> = [];
    const files = emptySegmentFiles();
    segmentFile(files, 'error', 'blog/[slug]', 'SLUG_500');
    const routes = route(
      '/blog/:slug',
      {
        default: () => {
          throw new Error('page broke');
        },
      },
      'blog/[slug]',
    );
    const logs = captureLogs();
    let result: Awaited<ReturnType<typeof renderRoute>>;
    try {
      result = await renderRoute(
        makeRequest('/blog/hello'),
        routes,
        slugLayouts(seen),
        undefined,
        undefined,
        undefined,
        { segmentFiles: files },
      );
    } finally {
      logs.restore();
    }
    expect('status' in result && result.status).toBe(500);
    const html = bodyOf(result);
    expect(html).toContain('SLUG_500');
    expect(headOf(html)).toContain('<title>HELLO</title>');
    // The page render, then the error page: the same params both times.
    expect(seen).toEqual([{ slug: 'hello' }, { slug: 'hello' }]);
  });

  it('a generateMetadata that throws never takes the custom not-found and error pages down', async () => {
    const layouts = new Map([
      layoutEntry('', {
        default: ({ children }) =>
          React.createElement(
            'html',
            null,
            React.createElement('head', null),
            React.createElement('body', null, children),
          ),
        metadata: { title: { default: 'Acme', template: '%s | Acme' } },
        generateMetadata: async () => {
          throw new Error('cms down');
        },
      }),
    ]);
    const specialPages = {
      notFound: async () => ({
        default: () => React.createElement('h1', null, 'CUSTOM_404'),
        metadata: { title: 'Not found' },
      }),
      error: async () => ({ default: () => React.createElement('h1', null, 'CUSTOM_500') }),
    };
    const logs = captureLogs();
    let missing: Awaited<ReturnType<typeof renderRoute>>;
    let broken: Awaited<ReturnType<typeof renderRoute>>;
    try {
      missing = await renderRoute(makeRequest('/missing'), new Map(), layouts, undefined, undefined, undefined, {
        specialPages,
      });
      // The page fails on the layout's generateMetadata; its error page must not.
      broken = await renderRoute(makeRequest('/'), route('/', {}), layouts, undefined, undefined, undefined, {
        specialPages,
      });
    } finally {
      logs.restore();
    }
    expect('status' in missing && missing.status).toBe(404);
    expect(bodyOf(missing)).toContain('CUSTOM_404');
    // The static metadata exports still apply.
    expect(headOf(bodyOf(missing))).toContain('<title>Not found | Acme</title>');
    expect('status' in broken && broken.status).toBe(500);
    expect(bodyOf(broken)).toContain('CUSTOM_500');
    expect(headOf(bodyOf(broken))).toContain('<title>Acme</title>');
    const metadataFailures = logs.lines().filter(l => String(l['msg']).startsWith('special page metadata failed'));
    expect(metadataFailures.length).toBe(2);
    expect(metadataFailures[0]?.['error']).toBe('cms down');
  });

  it("notFound() in a layout's generateMetadata renders that segment's not-found page", async () => {
    const files = emptySegmentFiles();
    segmentFile(files, 'not-found', 'blog/[slug]', 'SLUG_404');
    const layouts = new Map([
      rootLayout({ title: { default: 'Acme', template: '%s | Acme' } }),
      layoutEntry('blog/[slug]', {
        default: ({ children }) => React.createElement('article', null, children),
        generateMetadata: async () => notFound(),
      }),
    ]);
    const logs = captureLogs();
    let result: Awaited<ReturnType<typeof renderRoute>>;
    try {
      result = await renderRoute(
        makeRequest('/blog/gone'),
        route('/blog/:slug', {}, 'blog/[slug]'),
        layouts,
        undefined,
        undefined,
        undefined,
        { segmentFiles: files },
      );
    } finally {
      logs.restore();
    }
    expect('status' in result && result.status).toBe(404);
    expect(bodyOf(result)).toContain('SLUG_404');
    expect(headOf(bodyOf(result))).toContain('<title>Acme</title>');
    // Expected flow, not an error.
    expect(logs.lines().filter(l => l['level'] === 'error')).toEqual([]);
  });

  it('falls back to no tags when even the static metadata cannot be rendered', async () => {
    const layouts = new Map([
      layoutEntry('', {
        default: ({ children }) =>
          React.createElement('html', null, React.createElement('head', null), React.createElement('body', null, children)),
        // A null image entry: metadataToTags cannot read it.
        metadata: { openGraph: { images: [null as unknown as string] } },
        generateMetadata: async () => {
          throw new Error('cms down');
        },
      }),
    ]);
    const logs = captureLogs();
    let result: Awaited<ReturnType<typeof renderRoute>>;
    try {
      result = await renderRoute(makeRequest('/missing'), new Map(), layouts, undefined, undefined, undefined, {
        specialPages: { notFound: async () => ({ default: () => React.createElement('h1', null, 'CUSTOM_404') }) },
      });
    } finally {
      logs.restore();
    }
    expect('status' in result && result.status).toBe(404);
    expect(bodyOf(result)).toContain('CUSTOM_404');
    expect(headOf(bodyOf(result))).not.toContain('og:image');
  });
});

describe('relative metadata URL warning', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('warns once per route, however many distinct URLs requests produce', async () => {
    vi.stubEnv('GIO_SITE_URL', '');
    const routes = route('/search', {
      generateMetadata: async ctx => ({ alternates: { canonical: `/search?q=${String(ctx.query['q'])}` } }),
    });
    const logs = captureLogs();
    try {
      for (const q of ['a', 'b', 'c']) {
        const html = bodyOf(await renderRoute({ ...makeRequest('/search'), query: { q } }, routes, new Map()));
        expect(headOf(html)).toContain(`<link rel="canonical" href="/search?q=${q}"/>`);
      }
    } finally {
      logs.restore();
    }
    const warnings = logs.lines().filter(l => String(l['msg']).startsWith('metadata URL is relative'));
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.['route']).toBe('/search');
  });
});

describe('GIO_SITE_URL as metadataBase', () => {
  beforeEach(() => {
    vi.stubEnv('GIO_SITE_URL', 'https://site.example');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves relative Open Graph URLs', async () => {
    const html = bodyOf(
      await renderRoute(makeRequest('/'), route('/', { metadata: { openGraph: { images: '/og.png' } } }), new Map()),
    );
    expect(headOf(html)).toContain('<meta property="og:image" content="https://site.example/og.png"/>');
  });
});

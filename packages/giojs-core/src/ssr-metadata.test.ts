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
import type { GsspContext, LayoutEntry, LayoutModule, PageModule, RouteModule } from './router.ts';
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
      const warned = logs.lines().some(l => String(l['msg']).includes('renders its own <title>'));
      expect(warned).toBe(mode === 'development');
    }
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

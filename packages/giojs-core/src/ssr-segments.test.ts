/**
 * giojs-core/src/ssr-segments.test.ts
 *
 * Per-folder segment files in the server renderer: notFound() and
 * `{ notFound: true }` answer 404 with the nearest not-found.* inside the
 * layouts of its folder; a throw answers 500 with the nearest error.* (never
 * the one beside the layout that threw); loading.* wraps the folder in a
 * Suspense boundary that streams its fallback, without turning a failure
 * that would have failed the shell into a 200.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderRoute, type RenderExtras, type StreamRenderResult } from './ssr.ts';
import type { IPCRequest } from './context.ts';
import { notFound } from './not-found.ts';
import {
  emptySegmentFiles,
  type HandlerEntry,
  type LayoutEntry,
  type PageModule,
  type RouteModule,
  type SegmentFileKind,
  type SegmentFiles,
} from './router.ts';
import type { GioErrorProps } from './segment-tree.ts';

function makeRequest(path: string): IPCRequest {
  return {
    id: 'req-1',
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

/** Any function component - segment files take different props. */
type FileComponent = (props: never) => React.ReactNode;

function text(tag: string, content: string): () => React.ReactNode {
  return function Text() {
    return React.createElement(tag, null, content);
  };
}

function routeAt(
  pattern: string,
  dir: string,
  page: Partial<PageModule> & { default: PageModule['default'] },
): Map<string, RouteModule> {
  return new Map([
    [pattern, { filePath: `/app/${dir}/page.tsx`, urlPattern: pattern, dir, load: async () => page }],
  ]);
}

/** Layouts by folder; each wraps its children in a marker element ('' = root document). */
function layoutsAt(dirs: Record<string, string>): Map<string, LayoutEntry> {
  const layouts = new Map<string, LayoutEntry>();
  for (const [dir, marker] of Object.entries(dirs)) {
    layouts.set(dir, {
      filePath: `/app/${dir}/layout.tsx`,
      dir,
      load: async () => ({
        default: function Layout({ children }: { children?: React.ReactNode }) {
          if (dir === '') {
            return React.createElement(
              'html',
              null,
              React.createElement('head', null),
              React.createElement('body', { 'data-layout': marker }, children),
            );
          }
          return React.createElement('section', { 'data-layout': marker }, children);
        },
      }),
    });
  }
  return layouts;
}

function segmentFiles(
  files: Partial<Record<SegmentFileKind, Record<string, FileComponent>>>,
): SegmentFiles {
  const result = emptySegmentFiles();
  const keys = { 'not-found': 'notFound', error: 'error', loading: 'loading' } as const;
  for (const [kind, byDir] of Object.entries(files) as [SegmentFileKind, Record<string, FileComponent>][]) {
    for (const [dir, component] of Object.entries(byDir)) {
      result[keys[kind]].set(dir, {
        kind,
        dir,
        filePath: `/app/${dir}/${kind}.tsx`,
        load: async () => ({
          default: component as unknown as React.ComponentType<Record<string, unknown>>,
        }),
      });
    }
  }
  return result;
}

function errorFile(marker: string): (props: GioErrorProps) => React.ReactNode {
  return function ErrorFile({ error }: GioErrorProps) {
    return React.createElement('h1', null, `${marker} message=${error.message} digest=${error.digest ?? ''}`);
  };
}

const DIGEST = /digest=[0-9a-f]{12}/;

function status(result: Awaited<ReturnType<typeof renderRoute>>): number | undefined {
  if ('type' in result) return result.type === 'stream' ? result.head.status : undefined;
  return 'status' in result ? result.status : undefined;
}

function bodyOf(result: Awaited<ReturnType<typeof renderRoute>>): string {
  return 'body' in result && typeof result.body === 'string' ? result.body : '';
}

function expectStream(result: Awaited<ReturnType<typeof renderRoute>>): StreamRenderResult {
  if ('type' in result && result.type === 'stream') return result;
  throw new Error(`expected a stream result, got ${JSON.stringify(result).slice(0, 300)}`);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

function render(
  path: string,
  routes: Map<string, RouteModule>,
  layouts: Map<string, LayoutEntry>,
  extras: RenderExtras,
): ReturnType<typeof renderRoute> {
  return renderRoute(makeRequest(path), routes, layouts, undefined, undefined, undefined, extras);
}

/** A component that suspends until `ms` have passed, then renders `content`. */
function suspendsFor(ms: number, content: string, then?: () => never): () => React.ReactNode {
  const gate = new Promise<void>(resolve => setTimeout(resolve, ms));
  return function Suspends() {
    React.use(gate);
    if (then !== undefined) then();
    return React.createElement('p', null, content);
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── notFound() ───────────────────────────────────────────────────────────────

describe('notFound()', () => {
  const layouts = layoutsAt({
    '': 'ROOT_LAYOUT',
    '(shop)': 'SHOP_LAYOUT',
    '(shop)/products/[id]': 'PRODUCT_LAYOUT',
  });
  const files = segmentFiles({
    'not-found': { '': text('h1', 'ROOT_404'), '(shop)': text('h1', 'SHOP_404') },
  });

  it('in getServerSideProps renders the nearest not-found.* inside its own folder layouts, uncached', async () => {
    const routes = routeAt('/products/:id', '(shop)/products/[id]', {
      default: text('p', 'PRODUCT'),
      revalidate: 60,
      getServerSideProps: async () => notFound(),
    });
    const result = await render('/products/7', routes, layouts, { segmentFiles: files });
    expect(status(result)).toBe(404);
    expect('cacheable' in result && result.cacheable).toBe(false);
    const body = bodyOf(result);
    expect(body).toContain('SHOP_404');
    expect(body).not.toContain('ROOT_404');
    expect(body).toContain('ROOT_LAYOUT');
    expect(body).toContain('SHOP_LAYOUT');
    // The not-found file lives in (shop): the product folder's layout is below it.
    expect(body).not.toContain('PRODUCT_LAYOUT');
    expect(body).not.toContain('PRODUCT</p>');
  });

  it('{ notFound: true } from getServerSideProps does the same', async () => {
    const routes = routeAt('/products/:id', '(shop)/products/[id]', {
      default: text('p', 'PRODUCT'),
      getServerSideProps: async () => ({ notFound: true as const }),
    });
    const result = await render('/products/7', routes, layouts, { segmentFiles: files, streaming: true });
    expect(status(result)).toBe(404);
    expect(bodyOf(result)).toContain('SHOP_404');
  });

  it('flat props with a non-true notFound value still render the page', async () => {
    const routes = routeAt('/products/:id', '(shop)/products/[id]', {
      default: text('p', 'PRODUCT'),
      getServerSideProps: async () => ({ notFound: 'no' }),
    });
    const result = await render('/products/7', routes, layouts, { segmentFiles: files });
    expect(status(result)).toBe(200);
  });

  it('during the page render answers 404 on both the buffered and the streaming path', async () => {
    const Page = (): React.ReactNode => notFound();
    const buffered = await render(
      '/products/7',
      routeAt('/products/:id', '(shop)/products/[id]', { default: Page, revalidate: 60 }),
      layouts,
      { segmentFiles: files, streaming: true },
    );
    expect(status(buffered)).toBe(404);
    expect(bodyOf(buffered)).toContain('SHOP_404');
    const streamed = await render(
      '/products/7',
      routeAt('/products/:id', '(shop)/products/[id]', { default: Page }),
      layouts,
      { segmentFiles: files, streaming: true },
    );
    expect(status(streamed)).toBe(404);
    expect(bodyOf(streamed)).toContain('SHOP_404');
  });

  it('inside an app Suspense boundary still answers 404 while nothing has been sent', async () => {
    const Missing = (): React.ReactNode => notFound();
    const Page = (): React.ReactNode =>
      React.createElement(React.Suspense, { fallback: 'wait' }, React.createElement(Missing));
    const result = await render(
      '/products/7',
      routeAt('/products/:id', '(shop)/products/[id]', { default: Page }),
      layouts,
      { segmentFiles: files, streaming: true },
    );
    expect(status(result)).toBe(404);
  });

  it('falls back to app/not-found.*, then to the built-in page', async () => {
    const routes = routeAt('/blog/:slug', 'blog/[slug]', {
      default: text('p', 'POST'),
      getServerSideProps: async () => notFound(),
    });
    const withRoot = await render('/blog/x', routes, layouts, { segmentFiles: files });
    expect(status(withRoot)).toBe(404);
    expect(bodyOf(withRoot)).toContain('ROOT_404');
    const builtin = await render('/blog/x', routes, new Map(), {});
    expect(status(builtin)).toBe(404);
    expect(bodyOf(builtin)).toContain('Page not found');
  });

  it('uses the root files from specialPages when segment files were not discovered', async () => {
    const routes = routeAt('/blog/:slug', 'blog/[slug]', {
      default: text('p', 'POST'),
      getServerSideProps: async () => notFound(),
    });
    const result = await render('/blog/x', routes, new Map(), {
      specialPages: { notFound: async () => ({ default: text('h1', 'SPECIAL_404') }) },
    });
    expect(bodyOf(result)).toContain('SPECIAL_404');
  });

  it('answers unmatched URLs with app/not-found.* only, whatever folder they look like', async () => {
    const routes = routeAt('/products/:id', '(shop)/products/[id]', { default: text('p', 'PRODUCT') });
    const result = await render('/products/7/reviews', routes, layouts, { segmentFiles: files });
    expect(status(result)).toBe(404);
    expect(bodyOf(result)).toContain('ROOT_404');
    expect(bodyOf(result)).not.toContain('SHOP_LAYOUT');
  });

  it('a not-found.* whose own folder layout calls notFound() gives way to the next one up', async () => {
    const shopLayouts = new Map(layouts);
    shopLayouts.set('(shop)', {
      filePath: '/app/(shop)/layout.tsx',
      dir: '(shop)',
      load: async () => ({ default: () => notFound() }),
    });
    const routes = routeAt('/products/:id', '(shop)/products/[id]', { default: text('p', 'PRODUCT') });
    const result = await render('/products/7', routes, shopLayouts, { segmentFiles: files });
    expect(status(result)).toBe(404);
    expect(bodyOf(result)).toContain('ROOT_404');
  });

  it('in a route.ts handler answers a JSON 404', async () => {
    const handlers = new Map<string, HandlerEntry>([
      ['/api/items/:id', { filePath: '/app/api/route.ts', urlPattern: '/api/items/:id', methods: new Map([['GET', () => notFound()]]) }],
    ]);
    const result = await render('/api/items/1', new Map(), new Map(), { handlers });
    expect(status(result)).toBe(404);
    expect(JSON.parse(bodyOf(result))).toEqual({ error: 'Not Found' });
  });
});

// ─── error.* ──────────────────────────────────────────────────────────────────

describe('error.* on the server', () => {
  const layouts = layoutsAt({ '': 'ROOT_LAYOUT', dash: 'DASH_LAYOUT', 'dash/[team]': 'TEAM_LAYOUT' });
  const files = segmentFiles({
    error: { '': errorFile('ROOT_ERROR'), dash: errorFile('DASH_ERROR') },
  });
  const throwing = (): React.ReactNode => {
    throw new Error('secret page failure');
  };

  it('renders the nearest error.* inside the layouts above it: 500, digest only in production', async () => {
    const routes = routeAt('/dash/:team', 'dash/[team]', { default: throwing });
    const result = await render('/dash/a', routes, layouts, { segmentFiles: files, streaming: true });
    expect(status(result)).toBe(500);
    const body = bodyOf(result);
    expect(body).toContain('DASH_ERROR message=Internal Server Error');
    expect(body).toMatch(DIGEST);
    expect(body).not.toContain('secret page failure');
    expect(body).toContain('DASH_LAYOUT');
    expect(body).not.toContain('TEAM_LAYOUT');
    expect(body).not.toContain('ROOT_ERROR');
  });

  it('passes the real message in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const routes = routeAt('/dash/:team', 'dash/[team]', { default: throwing });
    const result = await render('/dash/a', routes, layouts, { segmentFiles: files });
    expect(bodyOf(result)).toContain('DASH_ERROR message=secret page failure');
  });

  it('catches getServerSideProps failures the same way', async () => {
    const routes = routeAt('/dash/:team', 'dash/[team]', {
      default: text('p', 'TEAM'),
      getServerSideProps: async () => {
        throw new Error('db down');
      },
    });
    const result = await render('/dash/a', routes, layouts, { segmentFiles: files });
    expect(status(result)).toBe(500);
    expect(bodyOf(result)).toContain('DASH_ERROR');
  });

  it('catches a layout of a folder below its own', async () => {
    const failing = new Map(layouts);
    failing.set('dash/[team]', {
      filePath: '/app/dash/[team]/layout.tsx',
      dir: 'dash/[team]',
      load: async () => ({ default: throwing }),
    });
    const routes = routeAt('/dash/:team', 'dash/[team]', { default: text('p', 'TEAM') });
    const result = await render('/dash/a', routes, failing, { segmentFiles: files });
    expect(status(result)).toBe(500);
    expect(bodyOf(result)).toContain('DASH_ERROR');
    expect(bodyOf(result)).toContain('DASH_LAYOUT');
  });

  it("never catches its own folder's layout - the error.* above does", async () => {
    const failing = new Map(layouts);
    failing.set('dash', { filePath: '/app/dash/layout.tsx', dir: 'dash', load: async () => ({ default: throwing }) });
    const routes = routeAt('/dash/:team', 'dash/[team]', { default: text('p', 'TEAM') });
    const result = await render('/dash/a', routes, failing, { segmentFiles: files });
    expect(status(result)).toBe(500);
    expect(bodyOf(result)).toContain('ROOT_ERROR');
    expect(bodyOf(result)).not.toContain('DASH_ERROR');
  });

  it('wraps the page in its error boundaries without changing the markup', async () => {
    const routes = routeAt('/dash/:team', 'dash/[team]', { default: text('p', 'TEAM_PAGE') });
    const result = await render('/dash/a', routes, layouts, { segmentFiles: files });
    expect(status(result)).toBe(200);
    expect(bodyOf(result)).toContain(
      '<section data-layout="DASH_LAYOUT"><section data-layout="TEAM_LAYOUT"><p>TEAM_PAGE</p></section></section>',
    );
  });
});

// ─── loading.* ────────────────────────────────────────────────────────────────

describe('loading.*', () => {
  const layouts = layoutsAt({ '': 'ROOT_LAYOUT', feed: 'FEED_LAYOUT' });
  const files = (): SegmentFiles =>
    segmentFiles({
      loading: { feed: text('p', 'FEED_LOADING') },
      error: { '': errorFile('ROOT_ERROR') },
      'not-found': { '': text('h1', 'ROOT_404') },
    });

  it('streams its fallback first while the page suspends, then the page', async () => {
    const routes = routeAt('/feed', 'feed', { default: suspendsFor(30, 'FEED_CONTENT') });
    const result = await render('/feed', routes, layouts, { segmentFiles: files(), streaming: true });
    const streamed = expectStream(result);
    expect(streamed.head.status).toBe(200);
    const html = await readAll(streamed.stream);
    const fallbackAt = html.indexOf('FEED_LOADING');
    const contentAt = html.indexOf('FEED_CONTENT');
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(contentAt).toBeGreaterThan(fallbackAt);
    // A pending boundary inside the folder's layout.
    expect(html.indexOf('FEED_LAYOUT')).toBeLessThan(html.indexOf('<!--$?-->'));
  });

  it('leaves buffered (cacheable) renders unchanged except for the boundary markers', async () => {
    const routes = routeAt('/feed', 'feed', { default: text('p', 'FEED_CONTENT'), revalidate: 60 });
    const result = await render('/feed', routes, layouts, { segmentFiles: files(), streaming: true });
    expect(status(result)).toBe(200);
    expect('cacheable' in result && result.cacheable).toBe(true);
    const body = bodyOf(result);
    expect(body).toContain('<!--$--><p>FEED_CONTENT</p><!--/$-->');
    expect(body).not.toContain('FEED_LOADING');
  });

  it('a page that throws before suspending still answers 500, streamed or buffered', async () => {
    const Page = (): React.ReactNode => {
      throw new Error('feed exploded');
    };
    for (const page of [{ default: Page }, { default: Page, revalidate: 60 }]) {
      const result = await render('/feed', routeAt('/feed', 'feed', page), layouts, {
        segmentFiles: files(),
        streaming: true,
      });
      expect(status(result)).toBe(500);
      expect(bodyOf(result)).toContain('ROOT_ERROR');
      expect(bodyOf(result)).not.toContain('FEED_LOADING');
    }
  });

  it('keeps the digest React logged for the error it caught', async () => {
    const Page = (): React.ReactNode => {
      throw new Error('feed exploded');
    };
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    let result;
    try {
      result = await render('/feed', routeAt('/feed', 'feed', { default: Page }), layouts, {
        segmentFiles: files(),
        streaming: true,
      });
    } finally {
      spy.mockRestore();
    }
    const digest = /digest=([0-9a-f]{12})/.exec(bodyOf(result))?.[1];
    expect(digest).toBeDefined();
    const logged = writes.join('').split('\n').filter(line => line.includes('feed exploded'));
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).toContain(digest);
  });

  it('a page that calls notFound() before suspending still answers 404', async () => {
    const Page = (): React.ReactNode => notFound();
    const result = await render('/feed', routeAt('/feed', 'feed', { default: Page }), layouts, {
      segmentFiles: files(),
      streaming: true,
    });
    expect(status(result)).toBe(404);
    expect(bodyOf(result)).toContain('ROOT_404');
  });

  it("keeps React's client fallback for errors in the app's own Suspense boundaries", async () => {
    const Broken = (): React.ReactNode => {
      throw new Error('widget failed');
    };
    const Page = (): React.ReactNode =>
      React.createElement(
        'main',
        null,
        'FEED_SHELL',
        React.createElement(React.Suspense, { fallback: 'widget loading' }, React.createElement(Broken)),
      );
    const result = await render('/feed', routeAt('/feed', 'feed', { default: Page }), layouts, {
      segmentFiles: files(),
      streaming: true,
    });
    const streamed = expectStream(result);
    expect(streamed.head.status).toBe(200);
    const html = await readAll(streamed.stream);
    expect(html).toContain('FEED_SHELL');
    expect(html).toContain('<!--$!-->');
  });

  it("keeps React's client fallback for an error after the content suspended (status already sent)", async () => {
    const Page = suspendsFor(10, 'never', () => {
      throw new Error('late failure');
    });
    const result = await render('/feed', routeAt('/feed', 'feed', { default: Page }), layouts, {
      segmentFiles: files(),
      streaming: true,
    });
    const streamed = expectStream(result);
    expect(streamed.head.status).toBe(200);
    const html = await readAll(streamed.stream);
    expect(html).toContain('FEED_LOADING');
    expect(html).not.toContain('never');
  });

  it('never caches a buffered render that recovered from an error in a boundary', async () => {
    const Page = suspendsFor(10, 'never', () => {
      throw new Error('late failure');
    });
    const result = await render('/feed', routeAt('/feed', 'feed', { default: Page, revalidate: 60 }), layouts, {
      segmentFiles: files(),
      streaming: true,
    });
    expect(status(result)).toBe(200);
    expect('cacheable' in result && result.cacheable).toBe(false);
    expect('cacheMaxAge' in result && result.cacheMaxAge).toBe(0);
    expect(bodyOf(result)).toContain('<!--$!-->');
  });

  it('attributes the 500 to the error that aborted the boundary, not one a Suspense inside it recovered from', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const Boom = (): React.ReactNode => {
      throw new Error('inner suspense boom');
    };
    const Later = (): React.ReactNode => {
      throw new Error('page boom');
    };
    const Page = (): React.ReactNode =>
      React.createElement(
        'div',
        null,
        React.createElement(React.Suspense, { fallback: 'inner loading' }, React.createElement(Boom)),
        React.createElement(Later),
      );
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const results = [];
    try {
      for (const page of [{ default: Page }, { default: Page, revalidate: 60 }]) {
        results.push(
          await render('/feed', routeAt('/feed', 'feed', page), layouts, {
            segmentFiles: files(),
            streaming: true,
          }),
        );
      }
    } finally {
      spy.mockRestore();
    }
    const pageBoomLines = writes.join('').split('\n').filter(line => line.includes('"error":"page boom"'));
    for (const result of results) {
      expect(status(result)).toBe(500);
      expect(bodyOf(result)).toContain('ROOT_ERROR message=page boom');
      // The reference points at the log line of the error that caused the 500.
      const digest = /digest=([0-9a-f]{12})/.exec(bodyOf(result))?.[1];
      expect(digest).toBeDefined();
      expect(pageBoomLines.some(line => line.includes(`"digest":"${digest ?? ''}"`))).toBe(true);
    }
  });

  it('judges nested loading.* boundaries the same buffered as streamed', async () => {
    // The feed layout suspends, so the inner boundary is only entered after
    // the outer content suspended: the page's error comes after the
    // response could have started, on both paths.
    const suspendingLayouts = (): Map<string, LayoutEntry> => {
      // Per render: React remembers a settled promise and would not suspend again.
      const gate = new Promise<void>(resolve => setTimeout(resolve, 10));
      const result = new Map(layouts);
      result.set('feed', {
        filePath: '/app/feed/layout.tsx',
        dir: 'feed',
        load: async () => ({
          default: function FeedLayout({ children }: { children?: React.ReactNode }) {
            React.use(gate);
            return React.createElement('section', { 'data-layout': 'FEED_LAYOUT' }, children);
          },
        }),
      });
      return result;
    };
    const nested = (): SegmentFiles =>
      segmentFiles({
        loading: { '': text('p', 'ROOT_LOADING'), feed: text('p', 'FEED_LOADING') },
        error: { '': errorFile('ROOT_ERROR') },
      });
    const Page = (): React.ReactNode => {
      throw new Error('feed exploded');
    };
    const streamed = expectStream(
      await render('/feed', routeAt('/feed', 'feed', { default: Page }), suspendingLayouts(), {
        segmentFiles: nested(),
        streaming: true,
      }),
    );
    expect(streamed.head.status).toBe(200);
    await readAll(streamed.stream);
    const buffered = await render(
      '/feed',
      routeAt('/feed', 'feed', { default: Page, revalidate: 60 }),
      suspendingLayouts(),
      { segmentFiles: nested(), streaming: true },
    );
    expect(status(buffered)).toBe(200);
    expect('cacheable' in buffered && buffered.cacheable).toBe(false);
    expect(bodyOf(buffered)).toContain('<!--$!-->');
  });

  it('never caches a PPR shell that holds a boundary React gave up on', async () => {
    const Broken = (): React.ReactNode => {
      throw new Error('widget failed');
    };
    const Page = (): React.ReactNode =>
      React.createElement(
        'main',
        null,
        'FEED_SHELL',
        React.createElement(React.Suspense, { fallback: 'widget loading' }, React.createElement(Broken)),
      );
    const routes = routeAt('/feed', 'feed', { default: Page, revalidate: 60, shell: 'cache' });
    const streamed = expectStream(await render('/feed', routes, layouts, { segmentFiles: files(), streaming: true }));
    expect(streamed.head.status).toBe(200);
    expect(streamed.head.cacheable).toBe(false);
    expect(streamed.head.cacheMaxAge).toBe(0);
    expect(streamed.head.pprShell).toBeUndefined();
    const html = await readAll(streamed.stream);
    expect(html).toContain('FEED_SHELL');
    expect(html).toContain('<!--$!-->');
  });

  it('asks live at the shell boundary whether a PPR shell may be stored', async () => {
    const routes = routeAt('/feed', 'feed', {
      default: suspendsFor(5, 'never', () => {
        throw new Error('hole failed');
      }),
      revalidate: 60,
      shell: 'cache',
    });
    const streamed = expectStream(await render('/feed', routes, layouts, { segmentFiles: files(), streaming: true }));
    expect(streamed.head.pprShell).toBe(true);
    expect(streamed.keepShell?.('')).toBe(true);
    await readAll(streamed.stream);
    // Asked live: once React reported the hole's error, the shell is not kept.
    expect(streamed.keepShell?.('')).toBe(false);
  });

  it("is the shell edge of a PPR page: the cached shell holds its fallback", async () => {
    const routes = routeAt('/feed', 'feed', {
      default: suspendsFor(30, 'FEED_HOLE'),
      revalidate: 60,
      shell: 'cache',
    });
    const result = await render('/feed', routes, layouts, { segmentFiles: files(), streaming: true });
    const streamed = expectStream(result);
    expect(streamed.shellBoundary).toBe('mark');
    expect(streamed.head.pprShell).toBe(true);
    const html = await readAll(streamed.stream);
    expect(html.indexOf('FEED_LOADING')).toBeLessThan(html.indexOf('FEED_HOLE'));
  });

  it('nests: an inner loading.* inside the outer folder layout', async () => {
    const nested = segmentFiles({ loading: { '': text('p', 'ROOT_LOADING'), feed: text('p', 'FEED_LOADING') } });
    const routes = routeAt('/feed', 'feed', { default: suspendsFor(30, 'FEED_CONTENT') });
    const result = await render('/feed', routes, layouts, { segmentFiles: nested, streaming: true });
    const html = await readAll(expectStream(result).stream);
    // The root boundary's content (the feed layout) rendered; only the inner one is pending.
    expect(html).toContain('FEED_LAYOUT');
    expect(html).not.toContain('ROOT_LOADING');
    expect(html.indexOf('FEED_LOADING')).toBeLessThan(html.indexOf('FEED_CONTENT'));
  });
});

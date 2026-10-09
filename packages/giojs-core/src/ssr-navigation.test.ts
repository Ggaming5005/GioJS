/**
 * giojs-core/src/ssr-navigation.test.ts
 *
 * The navigation context on the server: provided around the whole document
 * (the server-only root layout included) with the request's pathname,
 * params, query and locale, and carried in the hydration envelope so the
 * client runtime provides the same values. Not-found pages get it too,
 * with the params of the route that was not found.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderRoute, type StreamRenderResult } from './ssr.ts';
import type { IPCRequest } from './context.ts';
import type { LayoutEntry, RouteModule } from './router.ts';
import { navigationContext, searchFromQuery } from './navigation-context.ts';

function makeRequest(path: string, query: Record<string, string> = {}, locale = 'fr'): IPCRequest {
  return {
    id: 'req-1',
    method: 'GET',
    path,
    params: {},
    query,
    headers: {},
    body: null,
    bodyBase64: false,
    deploymentId: 'test-deploy',
    locale,
  };
}

function Probe({ where }: { where: string }): React.ReactElement {
  const nav = React.useContext(navigationContext());
  return React.createElement(
    'span',
    { 'data-probe': where },
    nav === null
      ? 'none'
      : `${nav.pathname}|${JSON.stringify(nav.params)}|${nav.search}|${nav.locale}|${nav.pattern}`,
  );
}

const routes = new Map<string, RouteModule>([
  [
    '/posts/:id',
    {
      filePath: '/app/posts/[id]/page.tsx',
      urlPattern: '/posts/:id',
      dir: 'posts/[id]',
      load: async () => ({
        default: () => React.createElement(Probe, { where: 'page' }),
      }),
    },
  ],
]);

const layouts = new Map<string, LayoutEntry>([
  [
    '',
    {
      filePath: '/app/layout.tsx',
      dir: '',
      load: async () => ({
        default: ({ children }: { children: React.ReactNode }) =>
          React.createElement(
            'html',
            null,
            React.createElement('body', null, React.createElement(Probe, { where: 'root' }), children),
          ),
      }),
    },
  ],
]);

const EXPECTED = '/posts/42|{&quot;id&quot;:&quot;42&quot;}|?tab=a&amp;q=x+y|fr|/posts/:id';

function envelopeOf(html: string): Record<string, unknown> {
  const json = html.match(/<script id="__gio_props" type="application\/json">([^<]*)<\/script>/)?.[1];
  if (json === undefined) throw new Error('no envelope');
  return JSON.parse(json) as Record<string, unknown>;
}

describe('navigation context on the server', () => {
  it('reaches the root layout and the page with identical values', async () => {
    const result = await renderRoute(
      makeRequest('/posts/42', { tab: 'a', q: 'x y' }),
      routes,
      layouts,
      undefined,
      undefined,
      new Map([['/posts/:id', '/e.js']]),
    );
    const body = 'body' in result ? result.body : '';
    expect(body).toContain(`<span data-probe="root">${EXPECTED}</span>`);
    expect(body).toContain(`<span data-probe="page">${EXPECTED}</span>`);
  });

  it('carries the same route info in the hydration envelope', async () => {
    const result = await renderRoute(
      makeRequest('/posts/42', { tab: 'a', q: 'x y' }),
      routes,
      layouts,
      undefined,
      undefined,
      new Map([['/posts/:id', '/e.js']]),
    );
    const envelope = envelopeOf('body' in result ? result.body : '');
    expect(envelope).toMatchObject({
      path: '/posts/42',
      pattern: '/posts/:id',
      params: { id: '42' },
      search: '?tab=a&q=x+y',
      locale: 'fr',
    });
    expect(new URLSearchParams(envelope['search'] as string).get('q')).toBe('x y');
  });

  it('wraps streamed renders too', async () => {
    const result = (await renderRoute(
      makeRequest('/posts/42', { tab: 'a', q: 'x y' }),
      routes,
      layouts,
      undefined,
      undefined,
      undefined,
      { streaming: true },
    )) as StreamRenderResult;
    expect(result.type).toBe('stream');
    const html = await new Response(result.stream).text();
    expect(html).toContain(`<span data-probe="root">${EXPECTED}</span>`);
  });

  it('is provided on not-found pages, without a pattern or params', async () => {
    const result = await renderRoute(makeRequest('/nope', {}, ''), routes, layouts, undefined, undefined, undefined, {
      specialPages: {
        notFound: async () => ({ default: () => React.createElement(Probe, { where: 'nf' }) }),
      },
    });
    expect('status' in result && result.status).toBe(404);
    const body = 'body' in result ? result.body : '';
    expect(body).toContain('<span data-probe="root">/nope|{}|||</span>');
    expect(body).toContain('<span data-probe="nf">/nope|{}|||</span>');
  });

  it("gives a matched route's not-found page that route's params, as its generateMetadata gets", async () => {
    const missing = new Map<string, RouteModule>([
      [
        '/posts/:id',
        {
          filePath: '/app/posts/[id]/page.tsx',
          urlPattern: '/posts/:id',
          dir: 'posts/[id]',
          load: async () => ({
            default: () => React.createElement(Probe, { where: 'page' }),
            getServerSideProps: async () => ({ notFound: true as const }),
          }),
        },
      ],
    ]);
    const result = await renderRoute(makeRequest('/posts/9', {}, ''), missing, layouts, undefined, undefined, undefined, {
      specialPages: {
        notFound: async () => ({ default: () => React.createElement(Probe, { where: 'nf' }) }),
      },
    });
    expect('status' in result && result.status).toBe(404);
    const body = 'body' in result ? result.body : '';
    // No pattern: a special page is not a route.
    expect(body).toContain('<span data-probe="nf">/posts/9|{&quot;id&quot;:&quot;9&quot;}|||</span>');
  });
});

describe('searchFromQuery', () => {
  it('re-encodes the decoded query so URLSearchParams returns it unchanged', () => {
    expect(searchFromQuery({})).toBe('');
    const search = searchFromQuery({ q: 'a&b=c', 'k y': '%' });
    expect(Object.fromEntries(new URLSearchParams(search))).toEqual({ q: 'a&b=c', 'k y': '%' });
    expect(search.startsWith('?')).toBe(true);
  });
});

describe('navigationContext', () => {
  it('lives under the global symbol @gio.js/react reads', () => {
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('gio.navigation-context')]).toBe(
      navigationContext(),
    );
  });
});

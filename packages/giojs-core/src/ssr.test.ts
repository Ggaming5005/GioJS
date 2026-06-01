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
import { renderRoute } from './ssr.ts';
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
      default: function Page({ title }: { title: string }) {
        return React.createElement('span', null, title);
      },
    });
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('body' in result && result.body).toContain('hello');
  });

  it('passes flat result directly when no props wrapper present', async () => {
    const routes = makeRoute('/', {
      getServerSideProps: async () => ({ title: 'flat' }),
      default: function Page({ title }: { title: string }) {
        return React.createElement('span', null, title);
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

  it('skips wrapWithDocument when root layout exists', async () => {
    const routes = makeRoute('/');
    const layouts = new Map<string, LayoutEntry>([
      ['/', makeLayout('/', 'root-layout')],
    ]);
    const result = await renderRoute(makeRequest('/'), routes, layouts);
    // wrapWithDocument adds the __gio div; root layout skips it
    expect('body' in result && result.body).not.toContain('id="__gio"');
  });

  it('adds wrapWithDocument when no root layout exists', async () => {
    const routes = makeRoute('/');
    const result = await renderRoute(makeRequest('/'), routes, noLayouts);
    expect('body' in result && result.body).toContain('id="__gio"');
  });
});

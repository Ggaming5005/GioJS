/**
 * giojs-core/src/route-label.test.ts
 *
 * The IPC `route` field Rust labels its metrics with: which pattern owns a
 * path (same precedence as rendering), and how ipc.ts stamps it on frames.
 */
import { describe, it, expect } from 'vitest';
import { resolveRoutePattern } from './ssr.ts';
import { withRoute } from './ipc.ts';
import type { HandlerEntry, RouteModule } from './router.ts';
import type { IPCError, IPCResponse } from './context.ts';

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

/**
 * packages/giojs-react/src/typed-href.test.ts
 *
 * href() substitution and encoding: static routes pass through, :param values
 * are URI-encoded, *catchall values keep '/' separators while each segment is
 * encoded. The local module augmentation mirrors what the generated
 * .gio/routes.d.ts does against '@gio.js/react' in a real project.
 */
import { describe, it, expect } from 'vitest';
import { href } from './typed-href.ts';

declare module './typed-href.ts' {
  interface GioRegisteredRoutes {
    '/': Record<string, never>;
    '/about': Record<string, never>;
    '/posts/:id': { id: string };
    '/users/:userId/posts/:postId': { userId: string; postId: string };
    '/docs/*slug': { slug: string };
  }
}

describe('href', () => {
  it('returns static patterns unchanged with no params argument', () => {
    expect(href('/')).toBe('/');
    expect(href('/about')).toBe('/about');
  });

  it('substitutes a :param segment', () => {
    expect(href('/posts/:id', { id: '42' })).toBe('/posts/42');
  });

  it('substitutes multiple :param segments', () => {
    expect(href('/users/:userId/posts/:postId', { userId: '7', postId: '99' })).toBe(
      '/users/7/posts/99',
    );
  });

  it('URI-encodes :param values', () => {
    expect(href('/posts/:id', { id: 'a b/c?' })).toBe('/posts/a%20b%2Fc%3F');
  });

  it('substitutes a *catchall segment keeping slash separators', () => {
    expect(href('/docs/*slug', { slug: 'guides/getting-started' })).toBe(
      '/docs/guides/getting-started',
    );
  });

  it('URI-encodes each segment of a *catchall value', () => {
    expect(href('/docs/*slug', { slug: 'a b/c?d' })).toBe('/docs/a%20b/c%3Fd');
  });

  it('substitutes a single-segment *catchall value', () => {
    expect(href('/docs/*slug', { slug: 'intro' })).toBe('/docs/intro');
  });
});

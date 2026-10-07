/**
 * Without .gio/routes.d.ts (before the first server start or `gio typegen`,
 * or a project whose tsconfig leaves it out) href() and useParams() accept
 * any pattern and read its params from the pattern itself.
 */
import { expectTypeOf } from 'vitest';
import { href, useParams, type RouteParamsOf, type RoutePattern } from '@gio.js/react';

expectTypeOf<RoutePattern>().toEqualTypeOf<string>();
expectTypeOf<RouteParamsOf<'/posts/:id'>>().toEqualTypeOf<{ id: string }>();
expectTypeOf<RouteParamsOf<'/shop/*path?'>>().toEqualTypeOf<{ path?: string }>();
expectTypeOf<RouteParamsOf<'/about'>>().toEqualTypeOf<Record<string, never>>();

export const links: string[] = [
  href('/'),
  href('/about'),
  href('/posts/:id', { id: '42' }),
  href('/users/:userId/posts/:postId', { userId: 'a', postId: 'b' }),
  href('/docs/*slug', { slug: 'guides/setup' }),
  href('/shop/*path?'),
  href('/shop/*path?', { path: 'shoes' }),
];

// @ts-expect-error - a dynamic pattern needs its params
href('/posts/:id');

// @ts-expect-error - and exactly those params
href('/posts/:id', { slug: '42' });

// @ts-expect-error - a static pattern takes none
href('/about', { id: '1' });

// A pattern only known at runtime: params are optional strings.
declare const dynamic: string;
export const fromString: string = href(dynamic, { anything: 'x' });

export function usePostId(): string {
  const params = useParams<'/posts/:id'>();
  expectTypeOf(params).toEqualTypeOf<{ id: string }>();
  return params.id;
}

export function useShape(): string {
  return useParams<{ slug: string }>().slug;
}

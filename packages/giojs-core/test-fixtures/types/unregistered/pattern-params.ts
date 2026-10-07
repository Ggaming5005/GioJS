/**
 * Without .gio/routes.d.ts (before the first server start, or a project
 * that does not include it) any pattern is accepted and its params are
 * parsed from the pattern itself.
 */
import { expectTypeOf } from 'vitest';
import type { GetServerSideProps, GsspContext, PageProps, RouteHandler, RoutePattern } from '@gio.js/core';

expectTypeOf<RoutePattern>().toEqualTypeOf<string>();

export function PostPage({ params }: PageProps<'/posts/:id'>): string {
  expectTypeOf(params).toEqualTypeOf<{ id: string }>();
  return params.id;
}

export function nested(ctx: GsspContext<'/users/:userId/posts/:postId'>): string {
  return `${ctx.params.userId}/${ctx.params.postId}`;
}

export function catchAll(ctx: GsspContext<'/docs/*slug'>): string {
  return ctx.params.slug;
}

export function optionalCatchAll(ctx: GsspContext<'/shop/*path?'>): string {
  expectTypeOf(ctx.params).toEqualTypeOf<{ path?: string }>();
  return ctx.params.path ?? '';
}

export function staticRoute({ params }: PageProps<'/about'>): number {
  expectTypeOf(params).toEqualTypeOf<Record<string, never>>();
  // @ts-expect-error - a static route has no params
  const id: string = params.id;
  return id.length;
}

export const getServerSideProps: GetServerSideProps<{ id: string }, '/posts/:id'> = async ctx => ({
  props: { id: ctx.params.id },
});

export const GET: RouteHandler<'/api/:version/items'> = req => req.params.version;

// A wide `string` pattern falls back to the untyped params map.
expectTypeOf<PageProps<string>['params']>().toEqualTypeOf<Record<string, string>>();

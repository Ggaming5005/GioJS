/**
 * Typed params from the generated .gio/routes.d.ts (public-types.test.ts
 * adds it to this program): registered patterns resolve their params from
 * the registry, unregistered ones are rejected, and the generator's types
 * agree with the pattern parser used before the file exists.
 */
import { expectTypeOf } from 'vitest';
import type {
  ActionArgs,
  GenerateMetadata,
  GioRequest,
  GsspContext,
  PageProps,
  ParamsFromPattern,
  RouteParamsOf,
  RoutePattern,
} from '@gio.js/core';

expectTypeOf<RouteParamsOf<'/posts/:id'>>().toEqualTypeOf<{ id: string }>();
expectTypeOf<RouteParamsOf<'/users/:userId/posts/:postId'>>().toEqualTypeOf<{
  userId: string;
  postId: string;
}>();
expectTypeOf<RouteParamsOf<'/docs/*slug'>>().toEqualTypeOf<{ slug: string }>();
expectTypeOf<RouteParamsOf<'/shop/*path?'>>().toEqualTypeOf<{ path?: string }>();
expectTypeOf<RouteParamsOf<'/about'>>().toEqualTypeOf<Record<string, never>>();

// The pattern parser (no routes.d.ts yet) types params exactly like the generator.
expectTypeOf<ParamsFromPattern<'/posts/:id'>>().toEqualTypeOf<GioJS.RegisteredRoutes['/posts/:id']>();
expectTypeOf<ParamsFromPattern<'/users/:userId/posts/:postId'>>().toEqualTypeOf<
  GioJS.RegisteredRoutes['/users/:userId/posts/:postId']
>();
expectTypeOf<ParamsFromPattern<'/docs/*slug'>>().toEqualTypeOf<GioJS.RegisteredRoutes['/docs/*slug']>();
expectTypeOf<ParamsFromPattern<'/shop/*path?'>>().toEqualTypeOf<GioJS.RegisteredRoutes['/shop/*path?']>();
expectTypeOf<ParamsFromPattern<'/about'>>().toEqualTypeOf<GioJS.RegisteredRoutes['/about']>();
expectTypeOf<ParamsFromPattern<'/'>>().toEqualTypeOf<GioJS.RegisteredRoutes['/']>();

// Registered routes narrow RoutePattern: typos fail, editors autocomplete.
expectTypeOf<'/posts/:id'>().toMatchTypeOf<RoutePattern>();
expectTypeOf<'/post/:id'>().not.toMatchTypeOf<RoutePattern>();

// PageProps / GsspContext / GioRequest / ActionArgs / GenerateMetadata from a pattern.
export function PostPage({ params, searchParams }: PageProps<'/posts/:id'>): string {
  expectTypeOf(params.id).toEqualTypeOf<string>();
  // @ts-expect-error - '/posts/:id' has no `slug` param
  void params.slug;
  return `${params.id}?${searchParams['q'] ?? ''}`;
}

export function docs(ctx: GsspContext<'/docs/*slug'>): string {
  return ctx.params.slug.split('/').join(' > ');
}

export function shop(ctx: GsspContext<'/shop/*path?'>): string {
  // Optional catch-all: may be absent.
  // @ts-expect-error - possibly undefined
  void ctx.params.path.length;
  return ctx.params.path ?? '';
}

export function handler(req: GioRequest<'/api/posts/:id'>): string {
  return req.params.id;
}

export function action(req: ActionArgs<'/posts/:id'>): string {
  return req.params.id;
}

export const generateMetadata: GenerateMetadata<'/posts/:id'> = ctx => ({ title: `Post ${ctx.params.id}` });

// Unregistered patterns are rejected once routes are registered.
// @ts-expect-error - not a registered route
export type Typo = PageProps<'/post/:id'>;
// @ts-expect-error - not a registered route
export type TypoCtx = GsspContext<'/blog/:id'>;

// A params shape still works where a pattern is not wanted.
export function byShape(ctx: GsspContext<{ id: string }>): string {
  return ctx.params.id;
}

interface PostParams {
  id: string;
}
// Interfaces too (they have no implicit index signature).
export function byInterface(req: GioRequest<PostParams>): string {
  return req.params.id;
}

// No argument: every param is possibly absent, as before.
export function untyped(ctx: GsspContext): string {
  expectTypeOf(ctx.params['id']).toEqualTypeOf<string | undefined>();
  return ctx.params['id'] ?? '';
}

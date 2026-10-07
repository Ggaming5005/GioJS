/**
 * giojs-core/src/app-types.ts
 *
 * Types for the conventions app files export - page and layout components,
 * getServerSideProps, getStaticPaths, route.ts handlers - so app code types
 * them from `@gio.js/core` instead of restating the shapes inline. Types
 * only. Each one mirrors what the renderer actually passes or accepts
 * (ssr.ts), never a wider wish list.
 *
 * The route-typed generics take a pattern (`'/posts/:id'`, checked against
 * the generated .gio/routes.d.ts) or a params shape (`{ id: string }`); see
 * route-params.ts.
 */
import type { GioRequest } from './context.ts';
import type { ActionRedirect } from './action.ts';
import type { GsspContext, NotFoundResult, PropsResult, RedirectResult } from './router.ts';
import type { GioErrorProps } from './segment-tree.ts';
import type { ParamsOf, RouteOrParams, StaticParamsOf } from './route-params.ts';

type DefaultParams = Record<string, string>;
type DefaultProps = Record<string, unknown>;

/** The context of getServerSideProps under the name Next.js uses for it. */
export type GetServerSidePropsContext<Route extends RouteOrParams = DefaultParams> = GsspContext<Route>;

/**
 * What getServerSideProps may return: `{ props }` (with optional `headers`
 * and cache `tags`), `{ redirect }`, `{ notFound: true }`, or `redirect()`.
 * Returning the props object itself (no `props` key) also renders, but is
 * left out here: a typed result is unambiguous.
 */
export type GetServerSidePropsResult<Props extends object = DefaultProps> =
  | PropsResult<Props>
  | RedirectResult
  | NotFoundResult
  | ActionRedirect;

/**
 * A page's getServerSideProps:
 * `export const getServerSideProps: GetServerSideProps<{ post: Post }, '/posts/:id'> = async ctx => ...`.
 * May also throw `redirect()` or `notFound()`.
 */
export type GetServerSideProps<
  Props extends object = DefaultProps,
  Route extends RouteOrParams = DefaultParams,
> = (
  ctx: GsspContext<Route>,
) => GetServerSidePropsResult<Props> | Promise<GetServerSidePropsResult<Props>>;

// Distributes over the result union: only the props-carrying members count.
// Matched by key, the way the renderer tells them apart, not against the
// exact result types: in an inferred return type `{ notFound: true }`
// widens to `{ notFound: boolean }`, and the members of a union of object
// literals carry each other's keys as `?: undefined`.
type PropsOfResult<Result> = Result extends ActionRedirect | { redirect: unknown } | { notFound: true }
  ? never
  : Result extends { props: infer Props }
    ? Props
    : Result extends { notFound: unknown }
      ? never
      : Result;

/**
 * The props a page renders with, read off its getServerSideProps:
 * `({ post }: InferPageProps<typeof getServerSideProps>)`.
 */
export type InferPageProps<Gssp> = Gssp extends (...args: never[]) => infer Result
  ? PropsOfResult<Awaited<Result>>
  : never;

/**
 * Props of a page component without getServerSideProps: the route params
 * and the query string. A page with getServerSideProps renders with
 * exactly the props it returned instead (see InferPageProps), plus
 * `actionData` on the render answering its action (see WithActionData).
 */
export interface PageProps<Route extends RouteOrParams = DefaultParams> {
  params: ParamsOf<Route>;
  /** The query string, one value per name. */
  searchParams: Record<string, string>;
}

/** Props of a layout component. */
export interface LayoutProps {
  children: React.ReactNode;
  /** The path of the page being rendered, without query - e.g. to mark the active nav link. */
  path: string;
}

/** Props of an error.* component: the error, and `reset` once hydrated. */
export type ErrorPageProps = GioErrorProps;

/** A not-found.* component renders with no props. */
export type NotFoundPageProps = Record<string, never>;

/** Untyped getStaticPaths params: a catch-all may be an array of segments. */
type DefaultStaticParams = Record<string, string | string[]>;

/**
 * getStaticPaths's result: one entry per page `gio export` writes. A
 * catch-all param is the path below it as one string (`'guides/setup'`)
 * or as its segments (`['guides', 'setup']`).
 */
export interface StaticPathsResult<Route extends RouteOrParams = DefaultStaticParams> {
  paths: Array<{ params: StaticParamsOf<Route> }>;
}

/**
 * A dynamic page's getStaticPaths, read by `gio export` only (the server
 * renders any params on demand):
 * `export const getStaticPaths: GetStaticPaths<'/posts/:id'> = () => ...`.
 */
export type GetStaticPaths<Route extends RouteOrParams = DefaultStaticParams> = () =>
  | StaticPathsResult<Route>
  | Promise<StaticPathsResult<Route>>;

/**
 * A route.ts method handler: `export const GET: RouteHandler<'/api/posts/:id'> = req => ...`.
 * Return a web `Response` (sent as is), a `GioEventStream` (GET: switches
 * to SSE), `null`/`undefined` (204), or any JSON-serializable value (200
 * `application/json`). `notFound()` answers a JSON 404. Handler responses
 * are never cached.
 */
export type RouteHandler<Route extends RouteOrParams = DefaultParams> = (
  req: GioRequest<Route>,
) => unknown;

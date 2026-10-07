/**
 * App file conventions typed from @gio.js/core: page, layout, error and
 * not-found components, getStaticPaths, route.ts handlers and plugins.
 */
import React from 'react';
import { expectTypeOf } from 'vitest';
import { GioEventStream } from '@gio.js/core';
import type {
  ActionArgs,
  ErrorPageProps,
  GetStaticPaths,
  GioNodePlugin,
  IPCRequest,
  IPCResponse,
  LayoutProps,
  Metadata,
  NotFoundPageProps,
  PageProps,
  RouteHandler,
  WithActionData,
} from '@gio.js/core';

export const metadata: Metadata = { title: { default: 'App', template: '%s | App' } };

export default function RootLayout({ children, path }: LayoutProps): React.JSX.Element {
  return (
    <html lang="en">
      <body data-path={path}>{children}</body>
    </html>
  );
}

export function ErrorPage({ error, reset }: ErrorPageProps): React.JSX.Element {
  expectTypeOf(error.message).toEqualTypeOf<string>();
  expectTypeOf(error.digest).toEqualTypeOf<string | undefined>();
  return <button onClick={reset}>{error.digest ?? error.message}</button>;
}

export function NotFound(_props: NotFoundPageProps): React.JSX.Element {
  return <h1>Not found</h1>;
}

export function Search({ searchParams }: PageProps): React.JSX.Element {
  return <p>{searchParams['q'] ?? ''}</p>;
}

// Rendered by the framework with the right props: JSX use is only a smoke test.
export const rendered = (
  <>
    <ErrorPage error={{ message: 'boom' }} />
    <NotFound />
    {/* @ts-expect-error - a not-found page takes no props */}
    <NotFound status={404} />
    {/* @ts-expect-error - an error page always gets `error` */}
    <ErrorPage />
  </>
);

export async function postAction(req: ActionArgs<'/posts/:id'>) {
  const form = await req.formData();
  const title = form.get('title');
  if (typeof title !== 'string' || title === '') return { status: 422, data: { error: 'title required' } };
  return { data: { saved: req.params.id } };
}

export function PostEditor({ params, actionData }: WithActionData<typeof postAction, PageProps<'/posts/:id'>>) {
  const error: string | undefined = actionData?.error;
  const saved: string | undefined = actionData?.saved;
  // @ts-expect-error - the action never returns a `count`
  void actionData?.count;
  return <form method="post" data-id={params.id} data-error={error} data-saved={saved} />;
}

export const getStaticPaths: GetStaticPaths<'/posts/:id'> = () => ({
  paths: ['1', '2'].map(id => ({ params: { id } })),
});

// @ts-expect-error - every entry needs the route's params
export const missingParam: GetStaticPaths<'/posts/:id'> = () => ({ paths: [{ params: {} }] });

// `gio export` takes a catch-all as one string or as its segments.
export const docsPaths: GetStaticPaths<'/docs/*slug'> = () => ({
  paths: [{ params: { slug: 'intro' } }, { params: { slug: ['guides', 'setup'] } }],
});
export const shopPaths: GetStaticPaths<'/shop/*path?'> = () => ({
  paths: [{ params: {} }, { params: { path: ['a', 'b'] } }],
});
// Untyped: any param may be an array.
export const untypedPaths: GetStaticPaths = () => ({ paths: [{ params: { slug: ['a', 'b'] } }] });

// @ts-expect-error - a single-segment param is a string, never segments
export const segmentArray: GetStaticPaths<'/posts/:id'> = () => ({ paths: [{ params: { id: ['1'] } }] });

export const GET: RouteHandler<'/api/posts/:id'> = req => {
  expectTypeOf(req.params).toEqualTypeOf<{ id: string }>();
  if (req.query['format'] === 'text') return new Response(req.params.id);
  if (req.query['stream'] !== undefined) {
    return new GioEventStream(stream => {
      stream.send({ id: req.params.id });
      return () => undefined;
    });
  }
  return { id: req.params.id };
};

export const POST: RouteHandler = async req => {
  const body = req.json<{ name: string }>();
  return { hello: body.name, id: req.params['id'] ?? null };
};

// @ts-expect-error - not a registered route
export const typo: RouteHandler<'/api/post/:id'> = () => null;

export const plugin: GioNodePlugin = {
  name: 'stamp',
  version: '1.0.0',
  async onRequest(req: IPCRequest): Promise<IPCRequest | IPCResponse> {
    if (req.path === '/blocked') {
      return { id: req.id, status: 403, headers: {}, body: 'no', cacheable: false, cacheMaxAge: 0 };
    }
    return req;
  },
};

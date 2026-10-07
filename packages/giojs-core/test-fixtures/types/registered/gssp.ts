/**
 * getServerSideProps typing: every result variant the renderer accepts
 * typechecks, anything else does not, and InferPageProps reads the page's
 * props off the function.
 */
import { expectTypeOf } from 'vitest';
import { notFound, redirect } from '@gio.js/core';
import type {
  GetServerSideProps,
  GetServerSidePropsContext,
  GetServerSidePropsResult,
  GsspContext,
  InferPageProps,
} from '@gio.js/core';

interface Post {
  id: string;
  title: string;
}
interface PostPageProps {
  post: Post;
}

export const getServerSideProps: GetServerSideProps<PostPageProps, '/posts/:id'> = async ctx => {
  expectTypeOf(ctx.params).toEqualTypeOf<{ id: string }>();
  if (ctx.params.id === 'old') return { redirect: { destination: '/posts/new', permanent: true } };
  if (ctx.params.id === 'gone') return { notFound: true };
  if (ctx.params.id === 'login') return redirect('/login');
  if (ctx.params.id === 'thrown') notFound();
  return {
    props: { post: { id: ctx.params.id, title: 'Hello' } },
    headers: { 'set-cookie': ['a=1', 'b=2'], 'x-extra': 'yes' },
    tags: [`post:${ctx.params.id}`],
  };
};

expectTypeOf<InferPageProps<typeof getServerSideProps>>().toEqualTypeOf<PostPageProps>();

// Inferred from an unannotated function: the props member wins.
export async function inferred(ctx: GsspContext<'/posts/:id'>) {
  if (ctx.params.id === 'gone') return { notFound: true as const };
  if (ctx.params.id === 'old') return redirect('/posts/new', 308);
  return { props: { title: `Post ${ctx.params.id}`, views: 3 } };
}
expectTypeOf<InferPageProps<typeof inferred>>().toEqualTypeOf<{ title: string; views: number }>();

// The plain Next.js-style form: no `as const`, so TypeScript widens the
// inferred `notFound: true` to `boolean` (and gives every member the
// others' keys as `?: undefined`).
export async function plain(ctx: GsspContext<'/posts/:id'>) {
  if (ctx.params.id === 'gone') return { notFound: true };
  if (ctx.params.id === 'old') return { redirect: { destination: '/posts/new', permanent: false } };
  return { props: { title: `Post ${ctx.params.id}` } };
}
expectTypeOf<InferPageProps<typeof plain>>().toEqualTypeOf<{ title: string }>();
export function PlainPage({ title }: InferPageProps<typeof plain>): string {
  return title;
}

// The flat form next to a notFound: the notFound member renders no props.
export function flatOrMissing(id: string) {
  if (id === 'gone') return { notFound: true };
  return { title: id };
}
export function FlatPage({ title }: InferPageProps<typeof flatOrMissing>): string {
  expectTypeOf(title).toEqualTypeOf<string>();
  return title;
}

// The flat form (props without a `props` key) renders too.
export function flat() {
  return { title: 'x' };
}
expectTypeOf<InferPageProps<typeof flat>>().toEqualTypeOf<{ title: string }>();

// Synchronous getServerSideProps is awaited the same way.
export const sync: GetServerSideProps<{ n: number }> = () => ({ props: { n: 1 } });

export const redirectWithCookie: GetServerSideProps = () => ({
  redirect: { destination: '/', permanent: false },
  headers: { 'set-cookie': 'session=; Max-Age=0' },
});

// @ts-expect-error - props must match the declared page props
export const wrongProps: GetServerSideProps<PostPageProps> = async () => ({ props: { post: 1 } });

// @ts-expect-error - `permanent` is required
export const halfRedirect: GetServerSideProps = async () => ({ redirect: { destination: '/' } });

// @ts-expect-error - notFound is `true` or absent
export const notFoundFalse: GetServerSideProps = async () => ({ notFound: false });

// @ts-expect-error - header values are strings or string arrays
export const badHeader: GetServerSideProps = async () => ({ props: {}, headers: { 'x-n': 1 } });

expectTypeOf<GetServerSidePropsContext<'/posts/:id'>>().toEqualTypeOf<GsspContext<'/posts/:id'>>();
expectTypeOf<{ notFound: true }>().toMatchTypeOf<GetServerSidePropsResult>();
expectTypeOf<{ props: PostPageProps; tags: string[] }>().toMatchTypeOf<GetServerSidePropsResult<PostPageProps>>();

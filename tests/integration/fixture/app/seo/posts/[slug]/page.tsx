/**
 * tests/integration/fixture/app/seo/posts/[slug]/page.tsx
 *
 * generateMetadata reusing the getServerSideProps props (no second fetch)
 * on a cached page. `?who=host` reads ctx.host in generateMetadata instead,
 * which must make the render personal (never cached).
 */
import React from 'react';
import type {
  Metadata,
  MetadataContext,
  MetadataExtras,
} from '../../../../../../../packages/giojs-core/src/public.ts';

export const revalidate = 60;

interface PostProps {
  title: string;
}

export async function getServerSideProps(ctx: MetadataContext): Promise<{ props: PostProps }> {
  return { props: { title: `Post ${ctx.params['slug']}` } };
}

export async function generateMetadata(ctx: MetadataContext, { props }: MetadataExtras): Promise<Metadata> {
  if (ctx.query['who'] === 'host') {
    return { title: `Served for ${ctx.host ?? 'unknown'}` };
  }
  const post = props as unknown as PostProps;
  return { title: post.title, alternates: { canonical: `/seo/posts/${ctx.params['slug']}` } };
}

export default function Post({ title }: PostProps): React.JSX.Element {
  return <h1>SEO_FIXTURE_POST {title}</h1>;
}
